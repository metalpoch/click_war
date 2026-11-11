def test_public_leaderboard_needs_no_auth(client):
    response = client.get("/api/leaderboard")

    assert response.status_code == 200
    assert response.json() == {
        "players": [],
        "total_players": 0,
        "total_clicks": 0,
    }


def test_protected_endpoints_reject_anonymous(client):
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/click").status_code == 401


def test_config_exposes_dev_login_only(client):
    body = client.get("/api/config").json()

    assert body == {"oauth_configured": False, "dev_login": True}


def test_dev_login_click_and_public_profile(client, login):
    login("neo")

    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["score"] == 0
    assert me.json()["rank"] == 1

    for _ in range(3):
        click = client.post("/api/click")
        assert click.status_code == 200

    assert click.json() == {"score": 3, "rank": 1}

    player = client.get("/api/players/neo")
    assert player.status_code == 200
    assert player.json()["score"] == 3
    assert player.json()["rank"] == 1

    board = client.get("/api/leaderboard").json()
    assert board["total_players"] == 1
    assert board["total_clicks"] == 3
    assert board["players"][0]["username"] == "neo"


def test_click_always_adds_exactly_one_point(client, login):
    login("neo")

    client.post("/api/click", json={"amount": 10_000})

    assert client.get("/api/me").json()["score"] == 1


def test_logout_clears_the_session_and_score_survives_relogin(client, login):
    login("neo")
    client.post("/api/click")
    client.post("/api/click")

    logout = client.post("/auth/logout")
    assert logout.status_code == 204
    assert client.get("/api/me").status_code == 401

    login("neo")
    assert client.get("/api/me").json()["score"] == 2


def test_forged_session_cookie_is_rejected(client):
    client.cookies.set("cw_session", "esto-no-es-una-cookie-firmada")

    assert client.get("/api/me").status_code == 401


def test_leaderboard_orders_ranks_and_paginates(client, add_user):
    add_user("ana", 10)
    add_user("beto", 30)
    add_user("carla", 20)

    first_page = client.get("/api/leaderboard?limit=2").json()
    assert [(p["rank"], p["username"], p["score"]) for p in first_page["players"]] == [
        (1, "beto", 30),
        (2, "carla", 20),
    ]
    assert first_page["total_players"] == 3
    assert first_page["total_clicks"] == 60

    second_page = client.get("/api/leaderboard?limit=2&offset=2").json()
    assert [(p["rank"], p["username"]) for p in second_page["players"]] == [(3, "ana")]


def test_tied_scores_share_a_rank(client, add_user):
    add_user("ana", 20)
    add_user("beto", 20)
    add_user("carla", 5)

    players = client.get("/api/leaderboard").json()["players"]
    assert [p["rank"] for p in players] == [1, 1, 3]
    assert client.get("/api/players/ana").json()["rank"] == 1
    assert client.get("/api/players/carla").json()["rank"] == 3


def test_player_lookup_is_case_insensitive_and_404s_cleanly(client, add_user):
    add_user("Neo", 7)

    found = client.get("/api/players/neo")
    assert found.status_code == 200
    assert found.json()["username"] == "Neo"

    missing = client.get("/api/players/nadie")
    assert missing.status_code == 404


def test_github_login_is_unavailable_without_credentials(client):
    assert client.get("/auth/github", follow_redirects=False).status_code == 503
    assert client.get("/auth/github/callback", follow_redirects=False).status_code == 503


def test_oauth_state_mismatch_is_rejected(monkeypatch, client):
    from dataclasses import replace

    from app import auth

    monkeypatch.setattr(
        auth,
        "settings",
        replace(auth.settings, github_client_id="gh-client", github_client_secret="gh-secret"),
    )
    client.cookies.set("cw_oauth_state", "estado-correcto")

    response = client.get(
        "/auth/github/callback?code=abc&state=estado-falso",
        follow_redirects=False,
    )

    assert response.status_code == 400


def test_github_oauth_roundtrip_and_profile_update(monkeypatch, client):
    from dataclasses import replace

    from app import auth

    monkeypatch.setattr(
        auth,
        "settings",
        replace(auth.settings, github_client_id="gh-client", github_client_secret="gh-secret"),
    )

    profile = {
        "id": 4242,
        "login": "octocat",
        "avatar_url": "https://example.com/octocat.png",
    }
    calls = {}

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload
            self.text = str(payload)

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, data=None):
            calls["token"] = {"url": url, "data": data}
            return FakeResponse({"access_token": "gho_test_token"})

        def get(self, url, headers=None):
            calls["profile"] = {"url": url, "headers": headers}
            return FakeResponse(profile)

    monkeypatch.setattr(auth.httpx, "Client", FakeClient)

    started = client.get("/auth/github", follow_redirects=False)
    assert started.status_code == 302
    assert "client_id=gh-client" in started.headers["location"]
    state = client.cookies.get("cw_oauth_state")
    assert state

    callback = client.get(
        f"/auth/github/callback?code=code-123&state={state}",
        follow_redirects=False,
    )
    assert callback.status_code == 303
    assert callback.headers["location"] == "/"
    assert calls["token"]["data"]["code"] == "code-123"
    assert calls["profile"]["headers"]["Authorization"] == "Bearer gho_test_token"

    me = client.get("/api/me").json()
    assert me["username"] == "octocat"
    assert me["score"] == 0

    client.post("/api/click")
    client.post("/api/click")

    # El mismo id de GitHub con otro login actualiza el perfil, no crea otra cuenta.
    profile["login"] = "octocat-renamed"
    profile["avatar_url"] = "https://example.com/renamed.png"
    client.get("/auth/github", follow_redirects=False)
    state = client.cookies.get("cw_oauth_state")
    client.get(
        f"/auth/github/callback?code=code-456&state={state}",
        follow_redirects=False,
    )

    updated = client.get("/api/me").json()
    assert updated["username"] == "octocat-renamed"
    assert updated["avatar_url"] == "https://example.com/renamed.png"
    assert updated["score"] == 2
    assert client.get("/api/leaderboard").json()["total_players"] == 1

    cancelled = client.get("/auth/github/callback", follow_redirects=False)
    assert cancelled.status_code == 303
    assert cancelled.headers["location"] == "/?auth=cancelled"


def test_invalid_limit_is_validated(client):
    assert client.get("/api/leaderboard?limit=0").status_code == 422
    assert client.get("/api/leaderboard?limit=101").status_code == 422


def test_healthz(client):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
