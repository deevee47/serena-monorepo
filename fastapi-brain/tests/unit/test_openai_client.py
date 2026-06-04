"""The shared AsyncOpenAI client must be constructed once and reused.

Constructing a fresh AsyncOpenAI per turn drops the HTTP/TLS connection pool
on the hot path of a live call (a new handshake to OpenAI every turn). The
shared helper memoizes a single client so connections are reused.
"""

from app.config.settings import settings


def test_get_openai_client_reuses_one_instance(monkeypatch):
    # A real construction needs a key; the property raises without one.
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-key")

    import app.lib.openai_client as mod

    mod.reset_openai_client()
    first = mod.get_openai_client()
    second = mod.get_openai_client()
    assert first is second
    mod.reset_openai_client()


def test_get_openai_client_uses_configured_key(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "sk-distinct-key")

    import app.lib.openai_client as mod

    constructed: list[str] = []

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            constructed.append(api_key)

    monkeypatch.setattr(mod, "AsyncOpenAI", FakeClient)
    mod.reset_openai_client()

    mod.get_openai_client()
    mod.get_openai_client()

    # Constructed exactly once, with the configured key.
    assert constructed == ["sk-distinct-key"]
    mod.reset_openai_client()
