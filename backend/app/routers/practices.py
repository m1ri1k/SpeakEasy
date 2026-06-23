import json
import tempfile
from datetime import timedelta, timezone
from io import BytesIO
from pathlib import Path
from statistics import mean
from xml.sax.saxutils import escape

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.shapes import Circle, Drawing, Line, Polygon, PolyLine, Rect, Wedge
from reportlab.graphics.shapes import String as GfxString
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session

from .. import models, schemas
from ..analysis import analyze_audio
from ..analysis.audio import build_overall, build_overall_from_metrics, build_strengths_from_metrics, can_decode_audio
from ..analysis.audio import detect_duration_seconds
from ..analysis.video import analyze_video
from ..database import SessionLocal, get_db
from ..routers.auth import get_current_user, hash_token
from ..storage import delete_from_s3, download_from_s3, get_presigned_url, save_upload, upload_to_s3


router = APIRouter(prefix="/api/practices", tags=["practices"])

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".mp4", ".mov", ".webm"}
MIN_DURATION_SECONDS = 180   # 3 минуты
MAX_DURATION_SECONDS = 900   # 15 минут
TRASH_RETENTION_DAYS = 30
PDF_FONT_REGULAR = "SpeakEasyArial"
PDF_FONT_BOLD = "SpeakEasyArialBold"
PDF_FONTS_REGISTERED = False


def create_analysis_report(db: Session, practice: models.Practice, file_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    if practice.media_type == "video":
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_audio = executor.submit(analyze_audio, file_path, practice.scenario)
            future_video = executor.submit(analyze_video, file_path, practice.scenario)
            analysis = future_audio.result()
            visual_analysis = future_video.result()
        metrics = list(analysis.metrics)
        recommendation = analysis.recommendation
        metrics.extend(visual_analysis.metrics)
        visual_warnings = [metric for metric in visual_analysis.metrics if metric.get("state") != "good"]
        if visual_warnings:
            recommendation = f"{recommendation} По видео: {visual_warnings[0].get('note', 'есть зона для улучшения')}"
    else:
        analysis = analyze_audio(file_path, scenario=practice.scenario)
        metrics = list(analysis.metrics)
        recommendation = analysis.recommendation

    score = combined_score(metrics, analysis.score) if analysis.transcript.strip() else analysis.score
    if score >= 100:
        recommendation = "Все ключевые метрики в норме. Сохраните текущий темп, громкость и структуру выступления."

    prev_progress = build_progress_for_practice(db, practice)
    progress = prev_progress + [{"date": practice.created_at.strftime("%d.%m.%Y"), "score": score, "practice_id": practice.id}]

    report = practice.analytics or models.AnalyticsReport(practice_id=practice.id)
    report.score = score
    report.overall = build_overall(score)
    report.recommendation = recommendation
    report.metrics_json = json.dumps(metrics, ensure_ascii=False)
    report.progress_json = json.dumps(progress, ensure_ascii=False)
    report.transcript = analysis.transcript
    report.transcript_json = json.dumps(analysis.transcript_blocks, ensure_ascii=False)
    practice.duration_seconds = analysis.duration_seconds
    practice.status = "done"
    db.add(report)
    db.commit()


def upload_draft_to_s3_job(practice_id: int, local_path: str) -> None:
    db = SessionLocal()
    try:
        practice = db.get(models.Practice, practice_id)
        if practice is None:
            Path(local_path).unlink(missing_ok=True)
            return
        s3_key = upload_to_s3(Path(local_path))
        practice.file_path = s3_key
        db.commit()
        Path(local_path).unlink(missing_ok=True)
    finally:
        db.close()


def run_analysis_job(practice_id: int, file_ref: str) -> None:
    db = SessionLocal()
    try:
        practice = db.get(models.Practice, practice_id)
        if practice is None or practice.status != "processing":
            if not file_ref.startswith("practices/"):
                Path(file_ref).unlink(missing_ok=True)
            return

        if file_ref.startswith("practices/"):
            # Already in S3 (draft re-processed) — download to temp
            tmp = Path(tempfile.mktemp(suffix=Path(file_ref).suffix))
            download_from_s3(file_ref, tmp)
            try:
                create_analysis_report(db, practice, tmp)
            finally:
                tmp.unlink(missing_ok=True)
        else:
            # New upload — upload to S3, then analyze from local file
            local = Path(file_ref)
            s3_key = upload_to_s3(local)
            practice.file_path = s3_key
            db.commit()
            try:
                create_analysis_report(db, practice, local)
            finally:
                local.unlink(missing_ok=True)
    finally:
        db.close()


def combined_score(metrics: list[dict], fallback_score: int) -> int:
    scores = [metric.get("score") for metric in metrics if isinstance(metric.get("score"), int | float)]
    if not scores:
        return fallback_score
    return max(min(round(mean(scores)), 100), 0)


def practice_to_read(practice: models.Practice) -> schemas.PracticeRead:
    deleted_at = practice.deleted_at
    trash_ref = deleted_at or (practice.created_at if practice.status == "deleted" else None)
    trash_expires_at = trash_ref + timedelta(days=TRASH_RETENTION_DAYS) if trash_ref else None
    return schemas.PracticeRead(
        id=practice.id,
        scenario=practice.scenario,
        media_type=practice.media_type,
        status=practice.status,
        original_filename=practice.original_filename,
        media_url=f"/api/practices/{practice.id}/media",
        duration_seconds=practice.duration_seconds,
        created_at=practice.created_at,
        deleted_at=deleted_at,
        trash_expires_at=trash_expires_at,
    )


def has_active_processing(db: Session, user_id: int, exclude_practice_id: int | None = None) -> bool:
    query = db.query(models.Practice.id).filter(
        models.Practice.user_id == user_id,
        models.Practice.status == "processing",
    )
    if exclude_practice_id is not None:
        query = query.filter(models.Practice.id != exclude_practice_id)
    return query.first() is not None


def trash_reference_date(practice: models.Practice):
    value = practice.deleted_at or practice.created_at
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def purge_expired_trash(db: Session, user_id: int | None = None) -> None:
    cutoff = models.utc_now() - timedelta(days=TRASH_RETENTION_DAYS)
    query = db.query(models.Practice).filter(models.Practice.status == "deleted")
    if user_id is not None:
        query = query.filter(models.Practice.user_id == user_id)

    expired_practices = [
        practice
        for practice in query.all()
        if trash_reference_date(practice) and trash_reference_date(practice) <= cutoff
    ]

    for practice in expired_practices:
        delete_from_s3(practice.file_path)
        db.delete(practice)

    if expired_practices:
        db.commit()


def get_user_from_media_token(token: str, db: Session) -> models.User:
    session = db.query(models.Session).filter(models.Session.token_hash == hash_token(token)).first()
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = db.get(models.User, session.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def register_pdf_fonts() -> None:
    global PDF_FONTS_REGISTERED

    if PDF_FONTS_REGISTERED:
        return

    regular_font = Path("C:/Windows/Fonts/arial.ttf")
    bold_font = Path("C:/Windows/Fonts/arialbd.ttf")

    if regular_font.exists() and bold_font.exists():
        pdfmetrics.registerFont(TTFont(PDF_FONT_REGULAR, str(regular_font)))
        pdfmetrics.registerFont(TTFont(PDF_FONT_BOLD, str(bold_font)))
    else:
        pdfmetrics.registerFont(TTFont(PDF_FONT_REGULAR, "Helvetica"))
        pdfmetrics.registerFont(TTFont(PDF_FONT_BOLD, "Helvetica-Bold"))

    PDF_FONTS_REGISTERED = True


def scenario_title(key: str) -> str:
    return {
        "presentation": "Презентация",
        "pitch": "Бизнес-питч",
        "podcast": "Подкаст",
        "free": "Свободная практика",
    }.get(key, key)


def format_duration(seconds: int | None) -> str:
    if not seconds:
        return "длительность не определена"

    minutes = seconds // 60
    rest = seconds % 60
    return f"{minutes} мин {rest} сек" if minutes else f"{rest} сек"


def metric_score_text(metric: dict) -> str:
    score = metric.get("score")
    return f"{score}/100" if isinstance(score, int | float) else "нет данных"


def build_progress_pdf_section(practice, db: Session, styles: dict) -> list:
    progress = build_progress_for_practice(db, practice)
    if len(progress) < 2:
        return []

    scores = [p["score"] for p in progress]
    dates = [p.get("date", "") for p in progress]
    n = len(progress)
    best = max(scores)
    delta = scores[-1] - scores[0]
    delta_str = f"+{delta}" if delta > 0 else str(delta)

    summary = (
        f"<font name='{PDF_FONT_BOLD}'>{n}</font> попыток · "
        f"лучший: <font name='{PDF_FONT_BOLD}'>{best}</font> · "
        f"динамика: <font name='{PDF_FONT_BOLD}'>{delta_str}</font>"
    )

    W, H = 460, 165
    pl, pr, pt, pb = 42, 10, 15, 42
    cw = W - pl - pr
    ch = H - pt - pb

    d = Drawing(W, H)

    for level in [0, 25, 50, 75, 100]:
        y = pb + (level / 100.0) * ch
        d.add(Line(pl, y, W - pr, y,
                   strokeColor=colors.HexColor("#e5e9f2"), strokeWidth=0.5))
        d.add(GfxString(pl - 4, y - 3, str(level),
                        fontSize=7, fillColor=colors.HexColor("#9ca3af"),
                        textAnchor="end", fontName=PDF_FONT_REGULAR))

    xs = [pl + (cw / (n - 1)) * i for i in range(n)] if n > 1 else [pl + cw / 2]
    ys = [pb + (s / 100.0) * ch for s in scores]

    area_pts = list(zip(xs, ys)) + [(xs[-1], pb), (xs[0], pb)]
    d.add(Polygon([c for xy in area_pts for c in xy],
                  fillColor=colors.HexColor("#eef6ff"), strokeColor=None))

    if n > 1:
        d.add(PolyLine([c for xy in zip(xs, ys) for c in xy],
                       strokeColor=colors.HexColor("#2563eb"), strokeWidth=2))

    for x, y, score, date in zip(xs, ys, scores, dates):
        d.add(Circle(x, y, 5, fillColor=colors.HexColor("#2563eb"),
                     strokeColor=colors.white, strokeWidth=1.5))
        d.add(GfxString(x, y + 8, str(int(score)),
                        fontSize=8, fillColor=colors.HexColor("#0b1020"),
                        textAnchor="middle", fontName=PDF_FONT_BOLD))
        if date:
            d.add(GfxString(x, pb - 14, date,
                            fontSize=7, fillColor=colors.HexColor("#6f7785"),
                            textAnchor="middle", fontName=PDF_FONT_REGULAR))

    return [
        Paragraph("Прогресс", styles["h2"]),
        Paragraph(summary, styles["meta"]),
        Spacer(1, 8),
        d,
        Spacer(1, 4),
    ]


def build_score_drawing(score: int) -> Drawing:
    W, H = 112, 158
    cx = W / 2
    cy = 100
    outer_r, inner_r = 40, 28

    d = Drawing(W, H)

    # Rounded card background
    d.add(Rect(0, 0, W, H, rx=10, ry=10,
               fillColor=colors.HexColor("#f7fbff"),
               strokeColor=colors.HexColor("#e7edf7"), strokeWidth=1))

    # Background ring (full)
    d.add(Wedge(cx, cy, outer_r, 0, 360, radius1=inner_r,
                fillColor=colors.HexColor("#e5e9f2"), strokeColor=None))

    # Progress ring (clockwise from top)
    extent = (score / 100.0) * 360
    d.add(Wedge(cx, cy, outer_r, 90 - extent, 90, radius1=inner_r,
                fillColor=colors.HexColor("#2563eb"), strokeColor=None))

    # White fill for donut hole
    d.add(Circle(cx, cy, inner_r - 1, fillColor=colors.white, strokeColor=None))

    # Score centered in circle
    d.add(GfxString(cx, cy - 10, str(score),
                    fontSize=24, fontName=PDF_FONT_BOLD,
                    fillColor=colors.HexColor("#2563eb"), textAnchor="middle"))

    if score >= 90:
        label = "Отлично"
    elif score >= 75:
        label = "Хорошо"
    elif score >= 50:
        label = "Средне"
    else:
        label = "Есть над чем работать"

    d.add(GfxString(cx, cy - outer_r - 20, label,
                    fontSize=9, fontName=PDF_FONT_BOLD,
                    fillColor=colors.HexColor("#0b1020"), textAnchor="middle"))
    d.add(GfxString(cx, cy - outer_r - 33, "Общая оценка",
                    fontSize=7.5, fontName=PDF_FONT_REGULAR,
                    fillColor=colors.HexColor("#6f7785"), textAnchor="middle"))
    return d


def build_report_pdf(practice: models.Practice, db: Session) -> BytesIO:
    if practice.analytics is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analytics report is not ready")

    register_pdf_fonts()
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"SpeakEasy report {practice.id}",
    )
    base_styles = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle(
            "SpeakEasyTitle",
            parent=base_styles["Title"],
            fontName=PDF_FONT_BOLD,
            fontSize=24,
            leading=30,
            textColor=colors.HexColor("#0b1020"),
            spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "SpeakEasyHeading",
            parent=base_styles["Heading2"],
            fontName=PDF_FONT_BOLD,
            fontSize=15,
            leading=20,
            textColor=colors.HexColor("#0b1020"),
            spaceBefore=14,
            spaceAfter=8,
        ),
        "body": ParagraphStyle(
            "SpeakEasyBody",
            parent=base_styles["BodyText"],
            fontName=PDF_FONT_REGULAR,
            fontSize=10.5,
            leading=15,
            textColor=colors.HexColor("#374151"),
        ),
        "body_justify": ParagraphStyle(
            "SpeakEasyBodyJustify",
            parent=base_styles["BodyText"],
            fontName=PDF_FONT_REGULAR,
            fontSize=10.5,
            leading=15,
            textColor=colors.HexColor("#374151"),
            alignment=TA_JUSTIFY,
        ),
        "brand": ParagraphStyle(
            "SpeakEasyBrand",
            parent=base_styles["BodyText"],
            fontName=PDF_FONT_BOLD,
            fontSize=18,
            leading=22,
            textColor=colors.HexColor("#2563eb"),
        ),
        "meta": ParagraphStyle(
            "SpeakEasyMeta",
            parent=base_styles["BodyText"],
            fontName=PDF_FONT_REGULAR,
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor("#6f7785"),
        ),
        "score": ParagraphStyle(
            "SpeakEasyScore",
            parent=base_styles["BodyText"],
            fontName=PDF_FONT_BOLD,
            fontSize=28,
            leading=34,
            alignment=1,
            textColor=colors.HexColor("#2563eb"),
        ),
    }

    analytics = practice.analytics
    metrics = json.loads(analytics.metrics_json or "[]")
    transcript = analytics.transcript or "Транскрибация недоступна."
    story = [
        Table(
            [
                [
                    Paragraph("SpeakEasy", styles["brand"]),
                    Paragraph(practice.created_at.strftime("%d.%m.%Y"), styles["meta"]),
                ]
            ],
            colWidths=[120 * mm, 54 * mm],
        ),
        Spacer(1, 10),
        Table(
            [
                [
                    [
                        Paragraph("Отчет по практике", styles["meta"]),
                        Paragraph(escape(practice.original_filename), styles["title"]),
                        Paragraph(
                            f"{escape(scenario_title(practice.scenario))} · {format_duration(practice.duration_seconds)} · {escape(analytics.overall)}",
                            styles["meta"],
                        ),
                    ],
                    build_score_drawing(analytics.score),
                ]
            ],
            colWidths=[128 * mm, 46 * mm],
            style=TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("ALIGN", (1, 0), (1, 0), "CENTER"),
                    ("LEFTPADDING", (0, 0), (0, 0), 12),
                    ("RIGHTPADDING", (0, 0), (0, 0), 12),
                    ("TOPPADDING", (0, 0), (0, 0), 12),
                    ("BOTTOMPADDING", (0, 0), (0, 0), 12),
                    ("LEFTPADDING", (1, 0), (1, 0), 6),
                    ("RIGHTPADDING", (1, 0), (1, 0), 6),
                    ("TOPPADDING", (1, 0), (1, 0), 6),
                    ("BOTTOMPADDING", (1, 0), (1, 0), 6),
                ]
            ),
        ),
        Paragraph("Главная рекомендация", styles["h2"]),
        Paragraph(escape(analytics.recommendation), styles["body"]),
        Paragraph("Метрики", styles["h2"]),
    ]

    metric_rows = [["Параметр", "Балл", "Значение"]]
    for metric in metrics:
        metric_rows.append(
            [
                Paragraph(escape(str(metric.get("title", ""))), styles["body"]),
                Paragraph(metric_score_text(metric), styles["body"]),
                Paragraph(escape(str(metric.get("value", ""))), styles["body"]),
            ]
        )

    story.append(
        Table(
            metric_rows,
            colWidths=[48 * mm, 28 * mm, 98 * mm],
            repeatRows=1,
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef6ff")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0b1020")),
                    ("FONTNAME", (0, 0), (-1, 0), PDF_FONT_BOLD),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#edf2fb")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            ),
        )
    )
    story.extend(build_progress_pdf_section(practice, db, styles))
    story.extend(
        [
            Paragraph("Транскрибация", styles["h2"]),
            Paragraph(escape(transcript).replace("\n", "<br/>"), styles["body_justify"]),
        ]
    )

    doc.build(story)
    buffer.seek(0)
    return buffer


@router.get("", response_model=list[schemas.PracticeRead])
def list_practices(
    include_deleted: bool = Query(False),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    purge_expired_trash(db, current_user.id)
    query = db.query(models.Practice).filter(models.Practice.user_id == current_user.id)
    if not include_deleted:
        query = query.filter(models.Practice.status != "deleted")

    practices = (
        query
        .order_by(models.Practice.created_at.desc())
        .all()
    )
    return [practice_to_read(practice) for practice in practices]


@router.post("/upload", response_model=schemas.PracticeRead, status_code=status.HTTP_201_CREATED)
def upload_practice(
    background_tasks: BackgroundTasks,
    scenario: str = Form("presentation"),
    media_type: str = Form("video"),
    mode: str = Form("process"),
    title: str | None = Form(None),
    file: UploadFile = File(...),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if media_type not in {"audio", "video"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="media_type must be audio or video")
    if mode not in {"process", "draft"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="mode must be process or draft")
    if mode == "process" and has_active_processing(db, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="РЈР¶Рµ РёРґРµС‚ РѕР±СЂР°Р±РѕС‚РєР° РґСЂСѓРіРѕРіРѕ С„Р°Р№Р»Р°. Р”РѕР¶РґРёС‚РµСЃСЊ РµРµ Р·Р°РІРµСЂС€РµРЅРёСЏ.",
        )
    if scenario == "podcast" and media_type == "video":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Подкаст доступен только для аудиозаписи.",
        )

    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Недопустимый формат файла{f' «{ext}»' if ext else ''}. Принимаются: MP3, WAV, MP4, MOV, WEBM.",
        )

    saved_path = save_upload(file)

    duration = detect_duration_seconds(saved_path)
    if mode == "process" and duration is None and not can_decode_audio(saved_path):
        saved_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Не удалось прочитать аудио в записи. Попробуйте записать еще раз или загрузить файл в формате WAV/MP3.",
        )
    if duration is not None:
        if duration < MIN_DURATION_SECONDS:
            saved_path.unlink(missing_ok=True)
            m, s = duration // 60, duration % 60
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Файл слишком короткий ({m}:{s:02d}). Минимальная длительность — 3 минуты.",
            )
        if duration > MAX_DURATION_SECONDS:
            saved_path.unlink(missing_ok=True)
            m, s = duration // 60, duration % 60
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Файл слишком длинный ({m}:{s:02d}). Максимальная длительность — 15 минут.",
            )

    display_title = (title or "").strip()[:120] or file.filename or saved_path.name

    practice = models.Practice(
        user_id=current_user.id,
        scenario=scenario,
        media_type=media_type,
        status="processing" if mode == "process" else "draft",
        original_filename=display_title,
        file_path=str(saved_path),
        duration_seconds=duration,
    )
    db.add(practice)
    db.commit()
    db.refresh(practice)

    if mode == "process":
        background_tasks.add_task(run_analysis_job, practice.id, str(saved_path))
    else:
        background_tasks.add_task(upload_draft_to_s3_job, practice.id, str(saved_path))
    return practice_to_read(practice)


def get_owned_practice_or_404(practice_id: int, current_user: models.User, db: Session) -> models.Practice:
    practice = db.get(models.Practice, practice_id)
    if practice is None or practice.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Practice not found")
    return practice


def stream_report_pdf(practice: models.Practice, db: Session) -> StreamingResponse:
    return StreamingResponse(
        build_report_pdf(practice, db),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="speakeasy-report-{practice.id}.pdf"'},
    )


def build_progress_for_practice(db: Session, practice: models.Practice) -> list[dict]:
    matching_practices = (
        db.query(models.Practice)
        .filter(
            models.Practice.user_id == practice.user_id,
            models.Practice.original_filename == practice.original_filename,
            models.Practice.scenario == practice.scenario,
            models.Practice.media_type == practice.media_type,
            models.Practice.status == "done",
        )
        .order_by(models.Practice.created_at.asc(), models.Practice.id.asc())
        .all()
    )

    progress = []
    for item in matching_practices:
        if item.analytics is None:
            continue

        progress.append(
            {
                "date": item.created_at.strftime("%d.%m.%Y"),
                "score": item.analytics.score,
                "practice_id": item.id,
            }
        )

    return progress


@router.get("/{practice_id}/report-pdf")
def download_report_pdf_safe(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return stream_report_pdf(get_owned_practice_or_404(practice_id, current_user, db), db)


@router.get("/{practice_id}/report.pdf")
def download_report_pdf(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return stream_report_pdf(get_owned_practice_or_404(practice_id, current_user, db), db)


@router.get("/{practice_id}", response_model=schemas.PracticeRead)
def get_practice(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    purge_expired_trash(db, current_user.id)
    return practice_to_read(get_owned_practice_or_404(practice_id, current_user, db))


@router.post("/{practice_id}/process", response_model=schemas.PracticeRead)
def process_practice(
    practice_id: int,
    background_tasks: BackgroundTasks,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    practice = get_owned_practice_or_404(practice_id, current_user, db)
    if practice.status == "deleted":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Practice is in trash")
    if practice.status == "done":
        return practice_to_read(practice)
    if has_active_processing(db, current_user.id, exclude_practice_id=practice.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="РЈР¶Рµ РёРґРµС‚ РѕР±СЂР°Р±РѕС‚РєР° РґСЂСѓРіРѕРіРѕ С„Р°Р№Р»Р°. Р”РѕР¶РґРёС‚РµСЃСЊ РµРµ Р·Р°РІРµСЂС€РµРЅРёСЏ.",
        )

    practice.status = "processing"
    db.commit()
    db.refresh(practice)
    background_tasks.add_task(run_analysis_job, practice.id, practice.file_path)
    return practice_to_read(practice)


@router.delete("/{practice_id}", response_model=schemas.PracticeRead)
def move_practice_to_trash(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    practice = get_owned_practice_or_404(practice_id, current_user, db)
    practice.status = "deleted"
    practice.deleted_at = models.utc_now()
    db.commit()
    db.refresh(practice)
    return practice_to_read(practice)


@router.post("/{practice_id}/restore", response_model=schemas.PracticeRead)
def restore_practice(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    practice = get_owned_practice_or_404(practice_id, current_user, db)
    if practice.status == "deleted":
        practice.status = "done" if practice.analytics is not None else "draft"
        practice.deleted_at = None
        db.commit()
        db.refresh(practice)
    return practice_to_read(practice)


@router.get("/{practice_id}/media")
def get_media(
    practice_id: int,
    token: str = Query(...),
    db: Session = Depends(get_db),
):
    current_user = get_user_from_media_token(token, db)
    practice = db.get(models.Practice, practice_id)
    if practice is None or practice.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Practice not found")

    url = get_presigned_url(practice.file_path)
    return RedirectResponse(url)


@router.get("/{practice_id}/analytics", response_model=schemas.AnalyticsRead)
def get_analytics(
    practice_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    practice = get_owned_practice_or_404(practice_id, current_user, db)

    if practice.analytics is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analytics report is not ready")

    metrics = json.loads(practice.analytics.metrics_json)
    score = practice.analytics.score
    return schemas.AnalyticsRead(
        practice_id=practice.id,
        score=score,
        overall=build_overall_from_metrics(metrics, score),
        recommendation=practice.analytics.recommendation,
        strengths=build_strengths_from_metrics(metrics, score),
        metrics=metrics,
        progress=build_progress_for_practice(db, practice),
        transcript=practice.analytics.transcript or "",
        transcript_blocks=json.loads(practice.analytics.transcript_json or "[]"),
    )


def media_content_type(file_path: Path, media_type: str) -> str:
    suffix = file_path.suffix.lower()
    if media_type == "video":
        return {
            ".mov": "video/quicktime",
            ".webm": "video/webm",
        }.get(suffix, "video/mp4")

    return {
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".m4a": "audio/mp4",
    }.get(suffix, "audio/mpeg")
