import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from . import auth
from .config import settings
from .db import User, get_db, init_db

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("clickwar")

STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if settings.dev_login:
        log.warning("DEV_LOGIN está activo: /auth/dev permite entrar sin GitHub")
    if settings.secret_key == "dev-only-secret-change-me":
        log.warning("SECRET_KEY es el valor de desarrollo; cámbialo antes de desplegar")
    yield


app = FastAPI(
    title="CLICK//WAR API",
    summary="El clicker competitivo: un click, un punto.",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)
app.include_router(auth.router)


class Player(BaseModel):
    rank: int
    username: str
    avatar_url: str | None
    score: int


class Me(Player):
    id: int


class Leaderboard(BaseModel):
    players: list[Player]
    total_players: int
    total_clicks: int


class ClickResult(BaseModel):
    score: int
    rank: int


class ClientConfig(BaseModel):
    oauth_configured: bool
    dev_login: bool


def _rank_for(db: Session, score: int) -> int:
    higher = db.scalar(select(func.count(User.id)).where(User.score > score)) or 0
    return int(higher) + 1


def _public_player(user: User, rank: int) -> Player:
    return Player(
        rank=rank,
        username=user.username,
        avatar_url=user.avatar_url,
        score=user.score,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz", tags=["meta"], summary="Estado del servicio")
def healthz(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/api/config", response_model=ClientConfig, tags=["meta"], summary="Config para el frontend")
def client_config() -> ClientConfig:
    return ClientConfig(
        oauth_configured=settings.oauth_configured,
        dev_login=settings.dev_login,
    )


@app.get(
    "/api/leaderboard",
    response_model=Leaderboard,
    tags=["public"],
    summary="Top de jugadores (público, sin auth)",
)
def leaderboard(
    limit: int = Query(default=10, ge=1, le=100, description="Cuántos jugadores devolver"),
    offset: int = Query(default=0, ge=0, le=1_000_000, description="Paginación"),
    db: Session = Depends(get_db),
) -> Leaderboard:
    rows = db.execute(
        select(User, func.rank().over(order_by=User.score.desc()).label("rank"))
        .order_by(User.score.desc(), User.created_at.asc(), User.id.asc())
        .offset(offset)
        .limit(limit)
    ).all()
    players = [_public_player(user, int(rank)) for user, rank in rows]

    total_players, total_clicks = db.execute(
        select(
            func.count(User.id),
            func.coalesce(func.sum(User.score), 0),
        )
    ).one()

    return Leaderboard(
        players=players,
        total_players=int(total_players),
        total_clicks=int(total_clicks),
    )


@app.get(
    "/api/players/{username}",
    response_model=Player,
    tags=["public"],
    summary="Puntaje de un jugador (público, sin auth)",
)
def player(username: str, db: Session = Depends(get_db)) -> Player:
    user = db.scalar(
        select(User)
        .where(func.lower(User.username) == username.lower())
        .order_by(User.score.desc())
        .limit(1)
    )
    if user is None:
        raise HTTPException(status_code=404, detail="Ese jugador no existe")
    return _public_player(user, _rank_for(db, user.score))


@app.get("/api/me", response_model=Me, tags=["player"], summary="Mi perfil y puntaje")
def me(user: User = Depends(auth.get_current_user), db: Session = Depends(get_db)) -> Me:
    return Me(id=user.id, **_public_player(user, _rank_for(db, user.score)).model_dump())


@app.post("/api/click", response_model=ClickResult, tags=["player"], summary="Suma un punto")
def click(
    user: User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
) -> ClickResult:
    score = db.scalar(
        update(User)
        .where(User.id == user.id)
        .values(score=User.score + 1)
        .returning(User.score)
    )
    db.commit()
    return ClickResult(score=int(score), rank=_rank_for(db, int(score)))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
