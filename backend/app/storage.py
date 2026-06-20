import os
from pathlib import Path
from uuid import uuid4

import boto3
from botocore.client import Config
from fastapi import UploadFile


UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads"
_YC_ENDPOINT = "https://storage.yandexcloud.net"
_YC_REGION = "ru-central1"


def ensure_upload_dir() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def safe_upload_name(filename: str) -> str:
    clean_name = Path(filename).name.replace(" ", "_")
    return f"{uuid4().hex}_{clean_name}"


def save_upload(file: UploadFile) -> Path:
    ensure_upload_dir()
    target = UPLOAD_DIR / safe_upload_name(file.filename or "practice.bin")
    with target.open("wb") as output:
        while chunk := file.file.read(1024 * 1024):
            output.write(chunk)
    return target


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=_YC_ENDPOINT,
        aws_access_key_id=os.environ["YC_KEY_ID"],
        aws_secret_access_key=os.environ["YC_SECRET"],
        region_name=_YC_REGION,
        config=Config(signature_version="s3v4"),
    )


def _bucket() -> str:
    return os.environ["YC_BUCKET"]


def upload_to_s3(local_path: Path) -> str:
    key = f"practices/{local_path.name}"
    _s3_client().upload_file(str(local_path), _bucket(), key)
    return key


def download_from_s3(s3_key: str, local_path: Path) -> None:
    _s3_client().download_file(_bucket(), s3_key, str(local_path))


def delete_from_s3(s3_key: str) -> None:
    try:
        _s3_client().delete_object(Bucket=_bucket(), Key=s3_key)
    except Exception:
        pass


def get_presigned_url(s3_key: str, expires: int = 3600) -> str:
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": s3_key},
        ExpiresIn=expires,
    )
