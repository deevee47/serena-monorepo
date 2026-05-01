"""Verify the hybrid classifier dispatches correctly per `classifier_mode`.

These tests don't touch real LLMs or Pinecone — they monkey-patch both backends
and assert the dispatcher's branching is correct.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services import classifier as classifier_module
from app.services.classifier import Classification
from app.services.objection_index import VoteResult


@pytest.fixture
def mock_llm():
    with patch.object(
        classifier_module,
        "_classify_with_llm",
        new=AsyncMock(return_value=Classification("PRICE", "NEGATIVE", 1.0, None)),
    ) as m:
        yield m


@pytest.fixture
def mock_pinecone_hit():
    with patch.object(
        classifier_module,
        "_safe_classify_via_pinecone",
        new=AsyncMock(return_value=VoteResult("TIMING", "NEUTRAL", 0.91, "strict", "not_now")),
    ) as m:
        yield m


@pytest.fixture
def mock_pinecone_miss():
    with patch.object(
        classifier_module, "_safe_classify_via_pinecone", new=AsyncMock(return_value=None)
    ) as m:
        yield m


@pytest.fixture
def llm_mode():
    with patch.object(classifier_module.settings, "classifier_mode", "llm"):
        yield


@pytest.fixture
def pinecone_mode():
    with patch.object(classifier_module.settings, "classifier_mode", "pinecone"):
        yield


@pytest.fixture
def shadow_mode():
    with patch.object(classifier_module.settings, "classifier_mode", "shadow"):
        yield


@pytest.mark.asyncio
async def test_llm_mode_only_calls_llm(llm_mode, mock_llm, mock_pinecone_hit):
    result = await classifier_module.classify_objection("anything", "PITCH", 50, "c1")
    assert result == Classification("PRICE", "NEGATIVE", 1.0, None)
    mock_llm.assert_awaited_once()
    mock_pinecone_hit.assert_not_called()


@pytest.mark.asyncio
async def test_pinecone_mode_uses_pinecone_when_hit(pinecone_mode, mock_llm, mock_pinecone_hit):
    result = await classifier_module.classify_objection("uh that's fine", "PITCH", 50, "c2")
    assert result == Classification("TIMING", "NEUTRAL", 0.91, "not_now")
    mock_pinecone_hit.assert_awaited_once()
    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_pinecone_mode_falls_back_to_llm_on_miss(pinecone_mode, mock_llm, mock_pinecone_miss):
    result = await classifier_module.classify_objection("ambiguous", "OBJECTION", 30, "c3")
    assert result == Classification("PRICE", "NEGATIVE", 1.0, None)
    mock_pinecone_miss.assert_awaited_once()
    mock_llm.assert_awaited_once()


@pytest.mark.asyncio
async def test_shadow_mode_calls_both_returns_llm(shadow_mode, mock_llm, mock_pinecone_hit):
    result = await classifier_module.classify_objection("hmm", "INTRO", 50, "c4")
    # Shadow mode must return LLM result regardless of Pinecone outcome
    assert result == Classification("PRICE", "NEGATIVE", 1.0, None)
    mock_llm.assert_awaited_once()
    mock_pinecone_hit.assert_awaited_once()


@pytest.mark.asyncio
async def test_shadow_mode_returns_llm_even_when_pinecone_disagrees(
    shadow_mode, mock_llm, mock_pinecone_hit
):
    # mock_llm returns PRICE NEGATIVE / no subtype; mock_pinecone_hit returns
    # TIMING NEUTRAL / not_now. Disagreement is fine — shadow returns LLM.
    result = await classifier_module.classify_objection("anything", "PITCH", 50, "c5")
    assert result.objection_type == "PRICE"
    assert result.sentiment == "NEGATIVE"
    assert result.subtype is None  # LLM never returns a subtype


@pytest.mark.asyncio
async def test_safe_classify_swallows_pinecone_errors():
    # _safe_classify_via_pinecone must never raise — any failure becomes None.
    async def boom(*args, **kwargs):
        raise RuntimeError("pinecone exploded")

    with patch.object(classifier_module, "classify_via_pinecone", new=boom):
        result = await classifier_module._safe_classify_via_pinecone("x", "c-err")
    assert result is None


@pytest.mark.asyncio
async def test_safe_classify_swallows_pinecone_timeout():
    import asyncio

    async def raise_timeout(coro, *args, **kwargs):
        coro.close()  # avoid "coroutine was never awaited" warning
        raise asyncio.TimeoutError()

    with patch.object(classifier_module.asyncio, "wait_for", new=raise_timeout):
        result = await classifier_module._safe_classify_via_pinecone("x", "c-timeout")
    assert result is None
