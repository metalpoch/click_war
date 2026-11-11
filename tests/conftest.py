import os

import pytest
from sqlalchemy import text

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://clicker:clicker@localhost:5432/clicker_test",
)

# Todo esto tiene que ocurrir antes de importar la app: config.py lee el entorno al importarse.
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["DEV_LOGIN"] = "true"
os.environ["GITHUB_CLIENT_ID"] = ""
os.environ["GITHUB_CLIENT_SECRET"] = ""
os.environ["SECRET_KEY"] = "test-secret-key"
os.environ["BASE_URL"] = "http://testserver"
os.environ["COOKIE_SECURE"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, User, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _database():
    init_db()
    yield


@pytest.fixture(autouse=True)
def _clean_database(_database):
    with engine.begin() as connection:
        connection.execute(text("TRUNCATE TABLE users RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def login(client):
    def _login(name: str = "neo"):
        response = client.get(f"/auth/dev?name={name}", follow_redirects=False)
        assert response.status_code == 303
        return response

    return _login


@pytest.fixture
def add_user():
    def _add(username: str, score: int = 0):
        with SessionLocal() as database:
            user = User(
                github_id=f"test:{username}",
                username=username,
                avatar_url=None,
                score=score,
            )
            database.add(user)
            database.commit()
            database.refresh(user)
            return user

    return _add
