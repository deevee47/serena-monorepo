import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock, patch

from app.config.settings import settings
from app.main import app


@pytest.mark.asyncio
async def test_classify_price_objection():
    with patch("app.services.classifier.AsyncOpenAI") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = AsyncMock(
            choices=[AsyncMock(message=AsyncMock(content="PRICE NEGATIVE"))]
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/classify",
                json={"call_id": "c1", "utterance": "That's too expensive", "stage": "PITCH", "score": 50},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    body = res.json()
    assert body["objection_type"] == "PRICE"
    assert body["sentiment"] == "NEGATIVE"
    assert 0.0 <= body["confidence"] <= 1.0
    mock_cls.assert_called_once_with(api_key=settings.llm_api_key)


@pytest.mark.asyncio
async def test_classify_trust_objection():
    with patch("app.services.classifier.AsyncOpenAI") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = AsyncMock(
            choices=[AsyncMock(message=AsyncMock(content="TRUST NEGATIVE"))]
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/classify",
                json={"call_id": "c2", "utterance": "I don't trust this brand", "stage": "OBJECTION", "score": 40},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    body = res.json()
    assert body["objection_type"] == "TRUST"
    assert body["sentiment"] == "NEGATIVE"
    mock_cls.assert_called_once_with(api_key=settings.llm_api_key)


@pytest.mark.asyncio
async def test_classify_falls_back_on_invalid_llm_output():
    with patch("app.services.classifier.AsyncOpenAI") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = AsyncMock(
            choices=[AsyncMock(message=AsyncMock(content="GIBBERISH"))]
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/classify",
                json={"call_id": "c3", "utterance": "Hmm", "stage": "INTRO", "score": 50},
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    body = res.json()
    assert body["objection_type"] == "NEUTRAL"
    assert body["sentiment"] == "NEUTRAL"
    mock_cls.assert_called_once_with(api_key=settings.llm_api_key)
