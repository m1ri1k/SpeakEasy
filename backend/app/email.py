import os
import smtplib
from email.message import EmailMessage
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]


def send_password_reset_email(to_email: str, reset_url: str) -> bool:
    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    sender = os.getenv("SMTP_FROM", username or "no-reply@speakeasy.local")

    if not host or not username or not password:
        print(f"Password reset link for {to_email}: {reset_url}")
        with (BASE_DIR / "password_reset_links.log").open("a", encoding="utf-8") as log_file:
            log_file.write(f"{to_email}: {reset_url}\n")
        return False

    message = EmailMessage()
    message["Subject"] = "Восстановление пароля SpeakEasy"
    message["From"] = sender
    message["To"] = to_email
    message.set_content(
        "Здравствуйте!\n\n"
        "Чтобы задать новый пароль для SpeakEasy, откройте ссылку:\n"
        f"{reset_url}\n\n"
        "Ссылка действует 30 минут. Если вы не запрашивали сброс пароля, просто проигнорируйте письмо."
    )

    with smtplib.SMTP(host, port) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        smtp.send_message(message)

    return True
