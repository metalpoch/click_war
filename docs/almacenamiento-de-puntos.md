# Cómo se almacenan los puntos

Esta es la guía corta para entender el corazón del juego: **un usuario, una fila, un contador de puntos**. No hay historial de clicks ni eventos guardados.

## Modelo mental

```text
GitHub OAuth ──▶ users (id, github_id, username, avatar_url, score, created_at)
                                      ▲
                                      │
              POST /api/click ──▶ UPDATE users SET score = score + 1
```

- Cada jugador es **una fila** de la tabla `users`.
- El puntaje vive en la columna `users.score`, un `BIGINT` que empieza en `0`.
- Cada click confirmado suma exactamente **1**.
- El servidor no guarda “cuándo” ni “desde dónde” se hizo cada click. Solo el total.
- Por eso `total_clicks` se calcula como `SUM(users.score)`.

## Esquema

Definido con SQLAlchemy en [app/db.py](../app/db.py#L22-L34):

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | `SERIAL` | Clave primaria interna |
| `github_id` | `VARCHAR(64)` | ID numérico de GitHub como texto; único |
| `username` | `VARCHAR(39)` | Login público de GitHub; indexado |
| `avatar_url` | `VARCHAR(512)` | Puede ser `NULL` |
| `score` | `BIGINT NOT NULL DEFAULT 0` | El puntaje |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Cuándo se creó la cuenta |

En SQL, equivalente conceptual:

```sql
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    github_id   VARCHAR(64) NOT NULL UNIQUE,
    username    VARCHAR(39) NOT NULL,
    avatar_url  VARCHAR(512),
    score       BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_users_username ON users (username);
```

Las tablas se crean solas al arrancar la app con `Base.metadata.create_all(engine)` ([app/db.py](../app/db.py#L42-L52)). No hay migraciones todavía.

## 1. Entrada del jugador

Después de que GitHub confirma la identidad, el callback hace un “upsert” lógico ([app/auth.py](../app/auth.py#L136-L148)):

```python
github_id = str(profile["id"])

user = db.scalar(select(User).where(User.github_id == github_id))
if user is None:
    user = User(github_id=github_id, username=username, avatar_url=avatar_url)
    db.add(user)
else:
    user.username = username
    user.avatar_url = avatar_url

db.commit()
```

El `score` no se toca: una cuenta nueva nace con `0` por el `server_default`. La cookie de sesión solo guarda el `id` firmado; el navegador nunca envía el puntaje.

## 2. Cada click

El endpoint está en [app/main.py](../app/main.py#L167-L179). Lo importante es esta operación:

```sql
UPDATE users
SET score = score + 1
WHERE id = :user_id
RETURNING score;
```

En SQLAlchemy:

```python
score = db.scalar(
    update(User)
    .where(User.id == user.id)
    .values(score=User.score + 1)
    .returning(User.score)
)
db.commit()
```

Después responde:

```json
{ "score": 42, "rank": 7 }
```

### Por qué es atómico

El incremento ocurre **dentro de PostgreSQL**, no en Python. No hay un patrón peligroso de “leer score, sumarle uno y guardar”:

```text
Si dos peticiones llegan a la vez:

 UPDATE score = score + 1 ──▶ bloquea la fila ──▶ 42
 UPDATE score = score + 1 ──▶ espera ───────────▶ 43
```

Cada `UPDATE` toma el valor más reciente de la fila bloqueada. No se pierden clicks aunque haya varias peticiones concurrentes, varios workers de Uvicorn o varios contenedores de la API. La base de datos es la fuente de verdad.

El cuerpo que envíe el cliente se ignora: no se puede pedir “sumame 10.000”. El servidor siempre suma uno.

## 3. Leer el puntaje y el ranking

### Top público

`GET /api/leaderboard` consulta los usuarios y calcula su posición con una window function ([app/main.py](../app/main.py#L117-L141)):

```sql
SELECT
    users.*,
    RANK() OVER (ORDER BY users.score DESC) AS rank
FROM users
ORDER BY users.score DESC, users.created_at ASC, users.id ASC
LIMIT 10 OFFSET 0;
```

- `RANK()` hace que dos jugadores empatados compartan posición: `1, 1, 3`.
- El desempate visual es por fecha de creación e `id`.
- También devuelve `total_players` y `SUM(score)` como `total_clicks`.

### Un jugador concreto

`GET /api/players/{username}` y `GET /api/me` calculan la posición contando cuántos tienen más puntos:

```sql
SELECT COUNT(*) + 1
FROM users
WHERE score > :mi_score;
```

Es suficiente para este tamaño de app y evita guardar una tabla de posiciones que habría que recalcular constantemente.

## 4. Qué hace el frontend

El navegador muestra el punto antes de que la petición termine, para que el botón no se sienta lento, pero **no decide el puntaje**:

1. Al hacer click suma uno de forma optimista en pantalla.
2. Encola un `POST /api/click` (hasta 6 peticiones en vuelo).
3. Cuando el servidor responde, reconcilia con el `score` real.
4. Si falla la petición, el contador vuelve al valor confirmado y muestra un aviso.
5. `/api/me` y `/api/leaderboard` se refrescan periódicamente.

Esto está en [app/static/app.js](../app/static/app.js) (`sendClick`, `pump`, `syncMe`).

## 5. Inspeccionar la base de datos

Con Docker:

```bash
docker compose exec db psql -U clicker -d clicker
```

Top actual:

```sql
SELECT id, username, score
FROM users
ORDER BY score DESC
LIMIT 10;
```

Puntaje de alguien:

```sql
SELECT username, score, created_at
FROM users
WHERE lower(username) = lower('tu-usuario');
```

Clicks totales de todo el juego:

```sql
SELECT COUNT(*) AS jugadores, COALESCE(SUM(score), 0) AS clicks
FROM users;
```

Ranking de un jugador:

```sql
SELECT COUNT(*) + 1 AS rank
FROM users
WHERE score > (SELECT score FROM users WHERE lower(username) = lower('tu-usuario'));
```

Para pruebas locales puedes sumar un punto a mano:

```sql
UPDATE users SET score = score + 1 WHERE username = 'tu-usuario';
```

No hay que hacer `UPDATE` desde la app: el endpoint ya lo hace.

## 6. Límites de este diseño

- **No hay historial.** No se puede saber a qué hora se hizo cada click ni detectar patrones; solo existe el total por usuario.
- **No hay anti-cheat.** Un script puede llamar a `/api/click` repetidamente. Falta rate limiting.
- **No hay migraciones.** `create_all` crea tablas nuevas, pero no modifica columnas existentes.
- **El ranking escanea usuarios.** `SUM(score)` y `RANK()` son baratos con miles de filas; si crece mucho, conviene un índice sobre `score` y/o una tabla de estadísticas.

Si en algún momento necesitas auditar clicks, el siguiente paso sería una tabla `clicks (id, user_id, created_at)` y mantener `users.score` como caché del total. Para el alcance de este juego no hace falta.

## Archivos involucrados

| Archivo | Responsabilidad |
| --- | --- |
| [app/db.py](../app/db.py#L22-L39) | Modelo `User`, engine y sesiones |
| [app/auth.py](../app/auth.py#L136-L152) | Crear/actualizar el usuario tras OAuth |
| [app/main.py](../app/main.py#L167-L179) | Incremento atómico del puntaje |
| [app/main.py](../app/main.py#L111-L159) | Endpoints públicos de ranking |
| [app/static/app.js](../app/static/app.js) | Contador optimista y sincronización |
| [tests/test_api.py](../tests/test_api.py) | Comportamiento esperado del puntaje y los empates |
