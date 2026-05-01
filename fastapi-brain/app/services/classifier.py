"""Hybrid objection classifier: Pinecone NN (fast) with LLM fallback.

Mode is set by `settings.classifier_mode`:
  - "pinecone"  Try Pinecone NN first; fall back to LLM if low confidence/error.
  - "shadow"    Run both; return LLM result; log Pinecone result for offline
                comparison. Use this during initial rollout to validate accuracy.
  - "llm"       Original behavior — LLM only. Kill switch for instant rollback.

Returns a `Classification(objection_type, sentiment, confidence, subtype)`.
Subtype is only populated by the Pinecone path (B-2) — the LLM fallback leaves
it None.
"""

import asyncio
from typing import NamedTuple

from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)

from app.config.settings import settings
from app.services.objection_index import classify_via_pinecone
from app.utils.errors import ClassificationError
from app.utils.logger import get_logger


class Classification(NamedTuple):
    objection_type: str
    sentiment: str
    confidence: float
    subtype: str | None

FEW_SHOT_EXAMPLES = [
    ("That's too expensive for me", "PRICE NEGATIVE"),
    ("The price is a bit high but I like the product", "PRICE POSITIVE"),
    ("I'm not sure if I can trust this brand", "TRUST NEGATIVE"),
    ("I've read good reviews but still a bit unsure", "TRUST NEUTRAL"),
    ("I don't really understand what this does", "CONFUSION NEGATIVE"),
    ("Can you explain the main features again?", "CONFUSION NEUTRAL"),
    ("I'm not ready to buy right now", "TIMING NEGATIVE"),
    ("Maybe next month would be better", "TIMING NEUTRAL"),
    ("That sounds great, I'm interested!", "POSITIVE_SIGNAL POSITIVE"),
    ("Okay, tell me more", "POSITIVE_SIGNAL NEUTRAL"),
    ("Hmm", "NEUTRAL NEUTRAL"),
    ("I see", "NEUTRAL NEUTRAL"),
]

VALID_TYPES = {"PRICE", "TRUST", "CONFUSION", "TIMING", "POSITIVE_SIGNAL", "NEUTRAL"}
VALID_SENTIMENTS = {"POSITIVE", "NEGATIVE", "NEUTRAL"}


async def classify_objection(utterance: str, stage: str, score: int, call_id: str) -> Classification:
    log = get_logger(call_id)
    mode = settings.classifier_mode

    if mode == "llm":
        return await _classify_with_llm(utterance, call_id)

    if mode == "shadow":
        # Run both; return LLM result; log agreement.
        pinecone_task = asyncio.create_task(_safe_classify_via_pinecone(utterance, call_id))
        llm_result = await _classify_with_llm(utterance, call_id)
        pinecone_result = await pinecone_task
        agreement = (
            pinecone_result is not None
            and pinecone_result.objection_type == llm_result.objection_type
            and pinecone_result.sentiment == llm_result.sentiment
        )
        log.info(
            "classifier_shadow",
            utterance=utterance[:80],
            llm=llm_result._asdict(),
            pinecone=pinecone_result._asdict() if pinecone_result else None,
            agreement=agreement,
        )
        return llm_result

    # mode == "pinecone": Pinecone first, LLM fallback on low confidence/error.
    pinecone_result = await _safe_classify_via_pinecone(utterance, call_id)
    if pinecone_result is not None:
        log.info(
            "classifier_pinecone_hit",
            utterance=utterance[:80],
            label=(pinecone_result.objection_type, pinecone_result.sentiment),
            confidence=round(pinecone_result.confidence, 3),
            method=pinecone_result.method,
            subtype=pinecone_result.subtype,
        )
        return Classification(
            objection_type=pinecone_result.objection_type,
            sentiment=pinecone_result.sentiment,
            confidence=pinecone_result.confidence,
            subtype=pinecone_result.subtype,
        )

    log.info("classifier_pinecone_miss_falling_back_to_llm", utterance=utterance[:80])
    return await _classify_with_llm(utterance, call_id)


async def _safe_classify_via_pinecone(utterance: str, call_id: str):
    """Wraps the Pinecone path so any error becomes a graceful fallback."""
    log = get_logger(call_id)
    try:
        return await asyncio.wait_for(classify_via_pinecone(utterance, call_id), timeout=2.0)
    except asyncio.TimeoutError:
        log.warning("classifier_pinecone_timeout", utterance=utterance[:80])
        return None
    except Exception as exc:  # noqa: BLE001 — any failure must fall back, not raise
        log.warning("classifier_pinecone_error", error_type=type(exc).__name__, message=str(exc))
        return None


async def _classify_with_llm(utterance: str, call_id: str) -> Classification:
    log = get_logger(call_id)
    client = AsyncOpenAI(api_key=settings.llm_api_key)

    messages: list[dict] = [
        {
            "role": "system",
            "content": (
                "You are a sales call objection classifier. "
                "Classify the customer's statement into exactly one objection type and one sentiment. "
                "Respond with exactly two words on one line: OBJECTION_TYPE SENTIMENT.\n"
                "Objection types: PRICE, TRUST, CONFUSION, TIMING, POSITIVE_SIGNAL, NEUTRAL\n"
                "Sentiments: POSITIVE, NEGATIVE, NEUTRAL"
            ),
        },
    ]
    for utterance_ex, label in FEW_SHOT_EXAMPLES:
        messages.append({"role": "user", "content": utterance_ex})
        messages.append({"role": "assistant", "content": label})
    messages.append({"role": "user", "content": utterance})

    try:
        response = await client.chat.completions.create(
            model=settings.openai_classifier_model,
            messages=messages,
            max_tokens=20,
            temperature=0,
        )
    except AuthenticationError as exc:
        log.error("classifier_error", error_type=type(exc).__name__, message=str(exc))
        raise ClassificationError("OpenAI authentication failed. Check OPENAI_API_KEY.") from exc
    except RateLimitError as exc:
        log.error("classifier_error", error_type=type(exc).__name__, message=str(exc))
        raise ClassificationError("Rate limit reached, try again shortly") from exc
    except APITimeoutError as exc:
        log.error("classifier_error", error_type=type(exc).__name__, message=str(exc))
        raise ClassificationError("Classifier timed out") from exc
    except APIConnectionError as exc:
        log.error("classifier_error", error_type=type(exc).__name__, message=str(exc))
        raise ClassificationError("OpenAI connection failed. Check network/DNS access.") from exc
    except APIError as exc:
        log.error("classifier_error", error_type=type(exc).__name__, message=str(exc))
        raise ClassificationError(f"Classifier API error: {exc.message}") from exc

    raw = (response.choices[0].message.content or "NEUTRAL NEUTRAL").strip().upper()
    parts = raw.split()

    objection_type = parts[0] if len(parts) >= 1 and parts[0] in VALID_TYPES else "NEUTRAL"
    sentiment = parts[1] if len(parts) >= 2 and parts[1] in VALID_SENTIMENTS else "NEUTRAL"
    confidence = 1.0 if objection_type != "NEUTRAL" or raw == "NEUTRAL NEUTRAL" else 0.5

    return Classification(objection_type, sentiment, confidence, subtype=None)
