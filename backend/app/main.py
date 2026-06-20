from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).resolve().parents[2] / "secrets.env")

from .database import Base, engine
from .routers import auth, practices
from .storage import ensure_upload_dir


Base.metadata.create_all(bind=engine)
ensure_upload_dir()


def upgrade_sqlite_schema() -> None:
    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as connection:
        columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(analytics_reports)").fetchall()
        }
        if "transcript" not in columns:
            connection.exec_driver_sql("ALTER TABLE analytics_reports ADD COLUMN transcript TEXT DEFAULT ''")
        if "transcript_json" not in columns:
            connection.exec_driver_sql("ALTER TABLE analytics_reports ADD COLUMN transcript_json TEXT DEFAULT '[]'")

        practice_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(practices)").fetchall()
        }
        if "deleted_at" not in practice_columns:
            connection.exec_driver_sql("ALTER TABLE practices ADD COLUMN deleted_at DATETIME")

        session_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(sessions)").fetchall()
        }
        if "expires_at" not in session_columns:
            connection.exec_driver_sql("ALTER TABLE sessions ADD COLUMN expires_at DATETIME")
            connection.exec_driver_sql(
                "UPDATE sessions SET expires_at = datetime(created_at, '+7 days') WHERE expires_at IS NULL"
            )


upgrade_sqlite_schema()

app = FastAPI(title="SpeakEasy API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://192.168.1.8:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(practices.router)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
