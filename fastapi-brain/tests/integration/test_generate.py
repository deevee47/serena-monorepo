from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.config.settings import settings
from app.main import app


def make_stream_chunk(content: str):
    chunk = MagicMock()
    chunk.choices = [MagicMock()]
    chunk.choices[0].delta.content = content
    return chunk


async def async_iter(items):
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_generate_returns_text():
    chunks = [make_stream_chunk("Hello, "), make_stream_chunk("let me help you.")]
    with patch("app.services.llm.AsyncOpenAI") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = async_iter(chunks)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/generate",
                json={
                    "call_id": "c1",
                    "utterance": "Tell me more",
                    "stage": "PITCH",
                    "score": 60,
                    "discount_available": 0,
                    "objection_type": None,
                    "conversation_history": [],
                    "product_context": None,
                },
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    body = res.json()
    assert body["text"] == "Hello, let me help you."
    mock_cls.assert_called_once_with(api_key=settings.llm_api_key)
    llm_messages = mock_client.chat.completions.create.call_args.kwargs["messages"]
    assert llm_messages[-1] == {"role": "user", "content": '[CUSTOMER]: "Tell me more"'}


@pytest.mark.asyncio
async def test_generate_with_product_context():
    chunks = [make_stream_chunk("The ProComfort chair is great for your back.")]
    with patch("app.services.llm.AsyncOpenAI") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client
        mock_client.chat.completions.create.return_value = async_iter(chunks)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            res = await ac.post(
                "/generate",
                json={
                    "call_id": "c2",
                    "utterance": "What are the benefits?",
                    "stage": "PITCH",
                    "score": 55,
                    "discount_available": 5,
                    "objection_type": "PRICE",
                    "conversation_history": [
                        {"speaker": "USER", "utterance": "Hi", "timestamp": "2024-01-01T00:00:00Z"},
                        {
                            "speaker": "AGENT",
                            "utterance": "Hello!",
                            "timestamp": "2024-01-01T00:00:01Z",
                        },
                    ],
                    "product_context": {
                        "product_id": "prod-001",
                        "name": "ProComfort Chair",
                        "price": 349.0,
                        "description": "Ergonomic chair",
                        "key_features": ["lumbar support", "adjustable", "ergonomic"],
                    },
                },
                headers={"X-Internal-Secret": settings.internal_service_secret},
            )
    assert res.status_code == 200
    assert len(res.json()["text"]) > 0
    mock_cls.assert_called_once_with(api_key=settings.llm_api_key)
    llm_messages = mock_client.chat.completions.create.call_args.kwargs["messages"]
    assert llm_messages[-3:] == [
        {"role": "user", "content": '[CUSTOMER]: "Hi"'},
        {"role": "assistant", "content": "Hello!"},
        {"role": "user", "content": '[CUSTOMER]: "What are the benefits?"'},
    ]
