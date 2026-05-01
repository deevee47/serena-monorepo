"""Unit tests for /converse and /converse/stream.

Mocks `converse_response_stream` (and `converse_response`) so the tests are
fast, deterministic, and don't hit OpenAI. Asserts the route validates
tool_call args and drops malformed ones rather than propagating them.
"""

import json
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.config.settings import settings
from app.main import app


def _async_iter(items):
    async def gen():
        for x in items:
            yield x
    return gen()


@pytest.mark.asyncio
async def test_converse_text_only_response():
    fake = {"text": "Got it.", "tool_call": None, "finish_reason": "stop"}
    with patch("app.routes.converse.converse_response", return_value=fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/converse",
                json={"call_id": "c1", "utterance": "hi", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    body = res.json()
    assert body["text"] == "Got it."
    assert body["tool_call"] is None


@pytest.mark.asyncio
async def test_converse_with_valid_tool_call():
    fake = {
        "text": "Sending the link to your WhatsApp now.",
        "tool_call": {"name": "send_whatsapp_checkout_link", "args": {"discount_percent": 5}},
        "finish_reason": "tool_calls",
    }
    with patch("app.routes.converse.converse_response", return_value=fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/converse",
                json={"call_id": "c2", "utterance": "yes please", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    body = res.json()
    assert body["tool_call"]["name"] == "send_whatsapp_checkout_link"
    assert body["tool_call"]["args"] == {"discount_percent": 5}


@pytest.mark.asyncio
async def test_converse_drops_invalid_tool_args():
    # LLM returns a 25% discount — Pydantic must reject and route should drop.
    fake = {
        "text": "Sending it now.",
        "tool_call": {"name": "send_whatsapp_checkout_link", "args": {"discount_percent": 25}},
        "finish_reason": "tool_calls",
    }
    with patch("app.routes.converse.converse_response", return_value=fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/converse",
                json={"call_id": "c3", "utterance": "ok", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    body = res.json()
    # Tool dropped, text preserved
    assert body["tool_call"] is None
    assert body["text"] == "Sending it now."


@pytest.mark.asyncio
async def test_converse_drops_unknown_tool_name():
    fake = {
        "text": "Sure.",
        "tool_call": {"name": "send_telegram_message", "args": {"text": "hi"}},
        "finish_reason": "tool_calls",
    }
    with patch("app.routes.converse.converse_response", return_value=fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/converse",
                json={"call_id": "c4", "utterance": "ok", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    body = res.json()
    assert body["tool_call"] is None


@pytest.mark.asyncio
async def test_converse_stream_emits_typed_sse_events():
    events = [
        {"type": "text", "delta": "Hey "},
        {"type": "text", "delta": "there"},
        {"type": "tool_call", "name": "send_whatsapp_product_info", "args": {}},
        {"type": "done", "finish_reason": "tool_calls"},
    ]
    with patch(
        "app.routes.converse.converse_response_stream",
        return_value=_async_iter(events),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/converse/stream",
                json={"call_id": "c5", "utterance": "ok", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            ) as res:
                assert res.status_code == 200
                lines = [
                    line[len("data: ") :]
                    async for line in res.aiter_lines()
                    if line.startswith("data: ")
                ]
    parsed = [json.loads(line) for line in lines]
    types = [p["type"] for p in parsed]
    assert "text" in types
    assert "tool_call" in types
    assert types[-1] == "done"


@pytest.mark.asyncio
async def test_converse_stream_drops_invalid_tool_call_event():
    events = [
        {"type": "text", "delta": "Sure."},
        {"type": "tool_call", "name": "send_whatsapp_checkout_link", "args": {"discount_percent": 99}},
        {"type": "done", "finish_reason": "tool_calls"},
    ]
    with patch(
        "app.routes.converse.converse_response_stream",
        return_value=_async_iter(events),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            async with ac.stream(
                "POST",
                "/converse/stream",
                json={"call_id": "c6", "utterance": "ok", "conversation_history": []},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            ) as res:
                lines = [
                    line[len("data: ") :]
                    async for line in res.aiter_lines()
                    if line.startswith("data: ")
                ]
    parsed = [json.loads(line) for line in lines]
    assert all(p["type"] != "tool_call" for p in parsed), "invalid tool_call should be dropped"
    assert any(p["type"] == "text" for p in parsed)
    assert parsed[-1]["type"] == "done"
