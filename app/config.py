import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    base_url: str
    github_client_id: str
    github_client_secret: str
    secret_key: str
    cookie_secure: bool
    dev_login: bool

    @property
    def oauth_configured(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)


settings = Settings(
    database_url=os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://clicker:clicker@localhost:5432/clicker",
    ),
    base_url=os.getenv("BASE_URL", "http://localhost:8000").rstrip("/"),
    github_client_id=os.getenv("GITHUB_CLIENT_ID", ""),
    github_client_secret=os.getenv("GITHUB_CLIENT_SECRET", ""),
    secret_key=os.getenv("SECRET_KEY", "dev-only-secret-change-me"),
    cookie_secure=_env_bool("COOKIE_SECURE"),
    dev_login=_env_bool("DEV_LOGIN"),
)
