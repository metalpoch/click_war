import logging
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import User, get_db

log = logging.getLogger("clickwar")

SESSION_COOKIE = "cw_session"
STATE_COOKIE = "cw_oauth_state"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN = "https://github.com/login/oauth/access_token"
GITHUB_API_USER = "https://api.github.com/user"

serializer = URLSafeTimedSerializer(settings.secret_key, salt="clickwar-session")
router = APIRouter(prefix="/auth", tags=["auth"])


def set_session_cookie(response: Response, user_id: int) -> None:
    token = serializer.dumps({"uid": user_id})
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="Inicia sesión con GitHub para jugar")
    try:
        payload = serializer.loads(raw, max_age=SESSION_MAX_AGE)
        user_id = int(payload["uid"])
    except (BadSignature, SignatureExpired, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="La cuenta de esta sesión ya no existe")
    return user


@router.get("/github", summary="Empieza el login con GitHub")
def github_login() -> RedirectResponse:
    if not settings.oauth_configured:
        raise HTTPException(status_code=503, detail="GitHub OAuth no está configurado")

    state = secrets.token_urlsafe(24)
    query = urlencode(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": f"{settings.base_url}/auth/github/callback",
            "scope": "read:user",
            "state": state,
            "allow_signup": "true",
        }
    )
    response = RedirectResponse(f"{GITHUB_AUTHORIZE}?{query}", status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    return response


@router.get("/github/callback", summary="Callback de GitHub OAuth", include_in_schema=False)
def github_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    expected_state = request.cookies.get(STATE_COOKIE)
    if not settings.oauth_configured:
        raise HTTPException(status_code=503, detail="GitHub OAuth no está configurado")
    if not code or not state:
        return RedirectResponse("/?auth=cancelled", status_code=303)
    if not expected_state or not secrets.compare_digest(expected_state, state):
        raise HTTPException(status_code=400, detail="Estado OAuth inválido. Inténtalo de nuevo.")

    try:
        with httpx.Client(timeout=10) as client:
            token_response = client.post(
                GITHUB_TOKEN,
                headers={"Accept": "application/json"},
                data={
                    "client_id": settings.github_client_id,
                    "client_secret": settings.github_client_secret,
                    "code": code,
                    "redirect_uri": f"{settings.base_url}/auth/github/callback",
                },
            )
            token_response.raise_for_status()
            access_token = token_response.json().get("access_token")
            if not access_token:
                log.warning("GitHub rechazó el intercambio de token: %s", token_response.text)
                raise HTTPException(status_code=400, detail="GitHub no entregó un token de acceso")

            user_response = client.get(
                GITHUB_API_USER,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            user_response.raise_for_status()
            profile = user_response.json()
    except httpx.HTTPError as exc:
        log.exception("Error hablando con GitHub")
        raise HTTPException(status_code=502, detail="No se pudo contactar con GitHub") from exc

    github_id = str(profile["id"])
    username = str(profile.get("login") or f"player-{github_id}")[:39]
    avatar_url = profile.get("avatar_url")

    user = db.scalar(select(User).where(User.github_id == github_id))
    if user is None:
        user = User(github_id=github_id, username=username, avatar_url=avatar_url)
        db.add(user)
    else:
        user.username = username
        user.avatar_url = avatar_url
    db.commit()
    db.refresh(user)

    response = RedirectResponse("/", status_code=303)
    set_session_cookie(response, user.id)
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


@router.post("/logout", status_code=204, summary="Cierra la sesión")
def logout() -> Response:
    response = Response(status_code=204)
    clear_session_cookie(response)
    return response


if settings.dev_login:

    @router.get("/dev", summary="Login falso solo para desarrollo", include_in_schema=False)
    def dev_login(
        name: str = Query(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9_-]+$"),
        db: Session = Depends(get_db),
    ) -> RedirectResponse:
        github_id = f"dev:{name}"
        user = db.scalar(select(User).where(User.github_id == github_id))
        if user is None:
            user = User(github_id=github_id, username=name, avatar_url=None)
            db.add(user)
            db.commit()
            db.refresh(user)
        response = RedirectResponse("/", status_code=303)
        set_session_cookie(response, user.id)
        return response
