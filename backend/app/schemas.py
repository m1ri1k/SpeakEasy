from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=6, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=20, max_length=256)
    password: str = Field(min_length=6, max_length=128)


class MessageResponse(BaseModel):
    message: str


class PasswordResetRequestResponse(BaseModel):
    message: str
    email_sent: bool = False
    dev_reset_url: str | None = None


class UserRead(BaseModel):
    id: int
    email: EmailStr
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime
    user: UserRead


class SessionTouchResponse(BaseModel):
    expires_at: datetime


class PracticeRead(BaseModel):
    id: int
    scenario: str
    media_type: str
    status: str
    original_filename: str
    media_url: str
    duration_seconds: int | None
    created_at: datetime
    deleted_at: datetime | None = None
    trash_expires_at: datetime | None = None


class AnalyticsRead(BaseModel):
    practice_id: int
    score: int
    overall: str
    recommendation: str
    strengths: list[str]
    metrics: list[dict[str, Any]]
    progress: list[dict[str, Any]]
    transcript: str
    transcript_blocks: list[dict[str, Any]]
