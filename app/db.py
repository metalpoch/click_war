import logging
import time
from collections.abc import Iterator
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, create_engine, func, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from .config import settings

log = logging.getLogger("clickwar")

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    github_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(39), index=True)
    avatar_url: Mapped[str | None] = mapped_column(String(512))
    score: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


def get_db() -> Iterator[Session]:
    with SessionLocal() as db:
        yield db


def init_db(attempts: int = 10, delay: float = 1.0) -> None:
    """Crea las tablas. Reintenta mientras PostgreSQL arranca (útil en Docker)."""
    for attempt in range(1, attempts + 1):
        try:
            Base.metadata.create_all(engine)
            return
        except OperationalError:
            if attempt == attempts:
                raise
            log.warning("PostgreSQL no está listo (intento %s/%s)", attempt, attempts)
            time.sleep(delay)
