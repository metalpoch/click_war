# CLICK//WAR

**Un click. Un punto. Cero piedad.**

Un clicker competitivo: entras con GitHub, haces click y peleas por el top de un ranking global. Sin vidas, sin monedas, sin árbol de habilidades. Solo puntos y orgullo.

![CLICK//WAR](docs/hero.png)

## Stack

- **Runtime:** Python 3.15
- **Backend:** FastAPI + Uvicorn
- **Base de datos:** PostgreSQL 18 + SQLAlchemy 2 + psycopg 3
- **Auth:** GitHub OAuth implementado a mano con `httpx` + cookie de sesión firmada con `itsdangerous`
- **Frontend:** HTML, CSS y JavaScript vanilla, sin build ni frameworks
- **Deploy:** Docker + Docker Compose

## Arquitectura

```text
.
├── app/
│   ├── main.py       # rutas de la API, ranking y archivos estáticos
│   ├── auth.py       # OAuth de GitHub, cookie de sesión y current_user
│   ├── db.py         # engine, modelo User e init_db
│   ├── config.py     # variables de entorno
│   └── static/       # frontend (HTML/CSS/JS/fuentes)
├── tests/            # tests de API con PostgreSQL real
├── docs/             # capturas + guía de almacenamiento
├── Dockerfile
├── compose.yaml
├── requirements.txt
└── requirements-dev.txt
```

La idea es que el proyecto se lea en una sentada:

- No hay JWT: la sesión es una cookie firmada que guarda solo el `id` del usuario.
- No hay tabla de sesiones, ni Redis, ni capa de servicios, ni repositorios.
- Los clicks se guardan con un `UPDATE users SET score = score + 1 ... RETURNING score` atómico. No se lee el puntaje, se incrementa y se devuelve.
- El ranking se resuelve con una window function (`RANK() OVER (ORDER BY score DESC)`), sin tablas de posiciones.
- Las tablas se crean al arrancar (`create_all`). Para este tamaño no hay Alembic.
- El frontend es estático: FastAPI sirve `index.html` y `/static`.
- Los puntos viven en `users.score` y cada click es un incremento atómico; no se guarda historial de clicks. Ver [cómo se almacenan los puntos](docs/almacenamiento-de-puntos.md).

Flujo de login:

```text
Navegador ──▶ GET /auth/github ──▶ GitHub (con state)
     ▲                                  │
     │                                  ▼
     └──── cookie firmada ◀── /auth/github/callback ──▶ upsert en PostgreSQL
```

## Arrancar con Docker

```bash
cp .env.example .env
# Edita SECRET_KEY y, si tienes, las credenciales de GitHub.
docker compose up --build
```

Abre <http://localhost:8000>.

Si el puerto `5432` ya está ocupado, añade `DB_PORT=5433` al `.env` y ajusta `DATABASE_URL` si corres la app fuera de Docker.

> PostgreSQL 18 cambió el volumen oficial a `/var/lib/postgresql` (antes era `/var/lib/postgresql/data`). Si vienes de PostgreSQL 17 o anterior con datos en el volumen anterior, no lo reutilices directamente: migra con `pg_dump`/`pg_restore` o empieza con un volumen limpio. `docker compose down -v` borra los datos.

Sin credenciales de GitHub puedes probar en local con el login de desarrollo:

```bash
# En .env
DEV_LOGIN=true
```

```text
http://localhost:8000/auth/dev?name=tu-nombre
```

> `DEV_LOGIN` crea una cuenta sin pasar por GitHub y deja una ruta abierta. **No lo actives en producción.**

## Configurar GitHub OAuth

1. Entra en <https://github.com/settings/developers> → **New OAuth App**.
2. Homepage URL: `http://localhost:8000` (o tu dominio).
3. Authorization callback URL: `http://localhost:8000/auth/github/callback`.
4. Copia el Client ID y el Client Secret en `.env`.
5. La app solo pide el scope `read:user`: nombre y avatar públicos. No lee emails ni repositorios.

Si cambias el dominio, actualiza `BASE_URL` y la callback URL de la OAuth App.

## Correr sin Docker

Con Python 3.15 y el PostgreSQL de Compose:

```bash
docker compose up -d db
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload
```

O con un PostgreSQL propio:

```bash
psql -U postgres -c "CREATE USER clicker WITH PASSWORD 'clicker';"
psql -U postgres -c "CREATE DATABASE clicker OWNER clicker;"
```

El `.env` por defecto apunta a `postgresql+psycopg://clicker:clicker@localhost:5432/clicker`.

## API

Documentación interactiva: <http://localhost:8000/api/docs>.

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `GET` | `/api/leaderboard?limit=10&offset=0` | No | Top global con rank, total de jugadores y clicks totales |
| `GET` | `/api/players/{username}` | No | Puntaje y posición de un jugador |
| `GET` | `/api/config` | No | Config pública para el frontend |
| `GET` | `/healthz` | No | Estado del servicio y conexión a la DB |
| `GET` | `/api/me` | Cookie | Perfil y puntaje del usuario actual |
| `POST` | `/api/click` | Cookie | Suma exactamente un punto |
| `GET` | `/auth/github` | No | Inicia el flujo OAuth |
| `GET` | `/auth/github/callback` | No | Callback de GitHub |
| `POST` | `/auth/logout` | Cookie | Cierra la sesión |
| `GET` | `/auth/dev?name=...` | No | Login falso, solo si `DEV_LOGIN=true` |

Ejemplo del endpoint público:

```bash
curl -s "http://localhost:8000/api/leaderboard?limit=3"
```

```json
{
  "players": [
    { "rank": 1, "username": "pixelpunk", "avatar_url": "https://...", "score": 128430 },
    { "rank": 2, "username": "ana_dev", "avatar_url": "https://...", "score": 98310 },
    { "rank": 3, "username": "mrclick", "avatar_url": "https://...", "score": 77650 }
  ],
  "total_players": 11,
  "total_clicks": 502875
}
```

```bash
curl -s "http://localhost:8000/api/players/pixelpunk"
```

```json
{ "rank": 1, "username": "pixelpunk", "avatar_url": "https://...", "score": 128430 }
```

Los empates comparten posición (`RANK`), y el orden dentro del empate es estable por fecha de registro e `id`.

### CORS

Los endpoints públicos aceptan `GET` desde cualquier origen. El resto del juego funciona con cookies del mismo origen.

## Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8000` | URL pública; se usa para la callback de OAuth |
| `DATABASE_URL` | `postgresql+psycopg://clicker:clicker@localhost:5432/clicker` | Conexión a PostgreSQL |
| `GITHUB_CLIENT_ID` | vacío | Client ID de la OAuth App |
| `GITHUB_CLIENT_SECRET` | vacío | Client Secret de la OAuth App |
| `SECRET_KEY` | valor de desarrollo | Firma la cookie de sesión; usa uno largo y aleatorio |
| `COOKIE_SECURE` | `false` | Ponlo en `true` cuando sirvas por HTTPS |
| `DEV_LOGIN` | `false` | Activa `/auth/dev` para entrar sin GitHub |
| `DB_PORT` | `5432` | Solo Compose: puerto del PostgreSQL en el host |

Genera un secreto con:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Tests

Los tests usan PostgreSQL de verdad. Crea una base aparte (`clicker_test`) y pásala por `TEST_DATABASE_URL`:

```bash
docker compose up -d db
docker compose exec db createdb -U clicker clicker_test

source .venv/bin/activate
TEST_DATABASE_URL=postgresql+psycopg://clicker:clicker@localhost:5432/clicker_test \
  python -m pytest -q
```

Cubren: endpoints públicos sin auth, login de desarrollo, clicks, ranking con empates, paginación, jugador inexistente, cookie falsificada, validación de límites y el flujo completo de OAuth con un GitHub simulado (incluyendo actualización de perfil sin duplicar cuentas).

> Los tests hacen `TRUNCATE` de `users`. No apuntes `TEST_DATABASE_URL` a una base con datos reales.

## CI/CD

El workflow [.github/workflows/docker.yml](.github/workflows/docker.yml) corre en cada `push` (cualquier rama o tag), en pull requests y manualmente con `workflow_dispatch`.

1. **Tests:** levanta PostgreSQL 18 como service, instala `requirements-dev.txt` y ejecuta `pytest -q` con Python 3.15.
2. **Imagen Docker:** Buildx construye la imagen desde el `Dockerfile`. Si el evento es un push o una ejecución manual, la publica en **GitHub Container Registry** (`ghcr.io/<owner>/<repo>`) usando el `GITHUB_TOKEN`. En pull requests solo se construye. No hay que configurar ningún secret.

Tags que genera:

| Evento | Tags |
| --- | --- |
| Push a una rama | nombre de la rama, `sha-<commit>` |
| Push a la rama por defecto | además `latest` |
| Push de un tag | nombre del tag, `sha-<commit>` y, si es semver, `1.2.3` / `1.2` |
| Pull request | `pr-<número>` (solo se construye, no se publica) |

```bash
docker pull ghcr.io/TU_USUARIO/TU_REPO:latest
```

La primera publicación crea el paquete como privado. Si quieres descargarlo sin autenticarte, cámbialo a público en la configuración de Packages del repositorio; si lo dejas privado, usa `docker login ghcr.io`.

Los tests tienen que pasar antes de construir o publicar la imagen. Si tu organización restringe el `GITHUB_TOKEN`, habilita permisos de escritura para paquetes en **Settings → Actions → General → Workflow permissions**; el workflow ya declara `packages: write`.

## Decisiones y límites

- **Cada click es una petición.** El servidor suma 1 aunque el cliente mande otra cosa. Aun así, no hay rate limiting ni anti-bot: un clicker siempre se puede automatizar. Si lo abres al público, añade un límite por usuario/IP.
- **Sin migraciones.** `create_all` es suficiente para empezar; si el modelo crece, toca Alembic.
- **Una sola cookie.** `HttpOnly`, `SameSite=Lax` y `Secure` configurable. Caduca a los 30 días. No hay refresh tokens.
- **El ranking se actualiza cada 5 segundos** en el frontend. Los clicks se muestran de forma optimista y se encolan en el navegador para que el botón responda incluso con latencia.
- **Sin tracking ni analytics.** El frontend solo carga fuentes locales y avatares de GitHub.
- **Producción:** `SECRET_KEY` propio, `COOKIE_SECURE=true`, HTTPS, `DEV_LOGIN=false`, backups de PostgreSQL y, si hace falta competir en serio, rate limiting del endpoint de click.

## Capturas

![Ranking](docs/leaderboard.png)

![Móvil](docs/mobile.png)
