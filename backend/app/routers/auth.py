import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..email import send_password_reset_email
from ..security import create_access_token, hash_password, hash_token, password_hash_needs_upgrade, verify_password


router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=False)
SESSION_TTL_MINUTES = int(os.getenv("SESSION_TTL_MINUTES", "30"))


def new_session_expires_at() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=SESSION_TTL_MINUTES)


def create_session(db: Session, user: models.User) -> tuple[str, models.Session]:
    token = create_access_token()
    session = models.Session(
        token_hash=hash_token(token),
        user_id=user.id,
        expires_at=new_session_expires_at(),
    )
    db.add(session)
    db.commit()
    return token, session


def get_frontend_reset_url(token: str) -> str:
    frontend_url = os.getenv("FRONTEND_URL", "http://127.0.0.1:5500/frontend/main.html")
    separator = "&" if "?" in frontend_url else "?"
    return f"{frontend_url}{separator}reset_token={token}"


def is_expired(expires_at: datetime) -> bool:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)


def as_utc(expires_at: datetime) -> datetime:
    if expires_at.tzinfo is None:
        return expires_at.replace(tzinfo=timezone.utc)
    return expires_at.astimezone(timezone.utc)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    session = (
        db.query(models.Session)
        .filter(models.Session.token_hash == hash_token(credentials.credentials))
        .first()
    )
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if is_expired(session.expires_at):
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")

    session.expires_at = new_session_expires_at()
    db.commit()

    user = db.get(models.User, session.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


@router.post("/register", response_model=schemas.AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    existing_user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if existing_user is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = models.User(
        email=payload.email.lower(),
        name=payload.name.strip(),
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token, session = create_session(db, user)
    return schemas.AuthResponse(access_token=token, user=user, expires_at=as_utc(session.expires_at))


@router.post("/login", response_model=schemas.AuthResponse)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    if password_hash_needs_upgrade(user.password_hash):
        user.password_hash = hash_password(payload.password)

    token, session = create_session(db, user)
    return schemas.AuthResponse(access_token=token, user=user, expires_at=as_utc(session.expires_at))


@router.post("/forgot-password", response_model=schemas.PasswordResetRequestResponse)
def forgot_password(payload: schemas.PasswordResetRequest, db: Session = Depends(get_db)):
    neutral_message = "Если аккаунт существует, мы отправили ссылку для восстановления."
    user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()

    if user is None:
        return schemas.PasswordResetRequestResponse(message=neutral_message)

    db.query(models.PasswordResetToken).filter(
        models.PasswordResetToken.user_id == user.id,
        models.PasswordResetToken.used_at.is_(None),
    ).update({"used_at": datetime.now(timezone.utc)})

    token = create_access_token()
    db.add(
        models.PasswordResetToken(
            token_hash=hash_token(token),
            user_id=user.id,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
    )
    db.commit()

    reset_url = get_frontend_reset_url(token)
    email_sent = False
    try:
        email_sent = send_password_reset_email(user.email, reset_url)
    except Exception as error:
        print(f"Could not send password reset email to {user.email}: {error}")

    return schemas.PasswordResetRequestResponse(
        message=neutral_message,
        email_sent=email_sent,
        dev_reset_url=None if email_sent else reset_url,
    )


@router.post("/reset-password", response_model=schemas.MessageResponse)
def reset_password(payload: schemas.PasswordResetConfirm, db: Session = Depends(get_db)):
    reset_token = (
        db.query(models.PasswordResetToken)
        .filter(models.PasswordResetToken.token_hash == hash_token(payload.token))
        .first()
    )

    if reset_token is None or reset_token.used_at is not None or is_expired(reset_token.expires_at):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Ссылка недействительна или устарела")

    user = db.get(models.User, reset_token.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Ссылка недействительна или устарела")

    user.password_hash = hash_password(payload.password)
    reset_token.used_at = datetime.now(timezone.utc)
    db.query(models.Session).filter(models.Session.user_id == user.id).delete()
    db.commit()

    return schemas.MessageResponse(message="Пароль обновлен. Теперь можно войти.")


@router.get("/me", response_model=schemas.UserRead)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.post("/touch", response_model=schemas.SessionTouchResponse)
def touch_session(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    session = (
        db.query(models.Session)
        .filter(models.Session.token_hash == hash_token(credentials.credentials))
        .first()
    )
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if is_expired(session.expires_at):
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")

    session.expires_at = new_session_expires_at()
    db.commit()
    return schemas.SessionTouchResponse(expires_at=as_utc(session.expires_at))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    if credentials is not None:
        session = (
            db.query(models.Session)
            .filter(models.Session.token_hash == hash_token(credentials.credentials))
            .first()
        )
        if session is not None:
            db.delete(session)
            db.commit()
