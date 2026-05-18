"""On-demand call-insight generator.

Loads a Call + its turns, asks the LLM for a structured summary, and writes
the result to the `call_insights` table. The dashboard's
`/api/calls/[id]/insights` route proxies here. Idempotent: a READY insight
is returned as-is; a PENDING/FAILED one is regenerated when `regenerate`
is true.
"""

import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict

from app.config.settings import settings
from app.lib.limiter import limiter
from app.utils.logger import get_logger

router = APIRouter()

_SYSTEM_PROMPT = """You are an analyst for a voice sales agent. Read the
transcript of a single phone call between the AGENT and a USER and produce a
strictly-valid JSON object with this shape:

{
  "summary": "<3-5 sentence neutral summary of what happened, written for an
              operator skimming a queue of calls. Include outcome,
              objections raised, what closed or didn't, and any concrete
              promise the agent made (discount, callback, etc.).>",
  "overall_sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED",
  "emotions": ["<one-word labels: e.g. 'curious', 'frustrated', 'hesitant',
               'enthusiastic', 'rushed', 'confused', 'reassured' — pick 2-4>"],
  "sentiment_trend": "improving" | "declining" | "stable" | "volatile",
  "sentiment_confidence": <float in [0,1]>,
  "service_concerns": [
    { "kind": "<delivery|price|trust|product_fit|payment|other>",
      "quote": "<short verbatim quote from the USER, if any>",
      "note": "<one-line operator note>" }
  ],
  "tags": ["<short kebab-case tags for filtering, e.g. 'wanted-discount',
           'asked-for-callback', 'needs-followup'>"]
}

Return ONLY the JSON object — no prose, no fences. If a list is empty, use
[]. If the transcript is too short to judge a field, prefer NEUTRAL /
stable / 0.5 / empty arrays."""


class GenerateInsightRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    call_id: str
    regenerate: bool = False


class GenerateInsightResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    call_id: str
    status: Literal["PENDING", "READY", "FAILED"]
    summary: str
    overall_sentiment: Literal["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"]
    emotions: list[str]
    sentiment_trend: str
    sentiment_confidence: float
    service_concerns: list[dict[str, Any]]
    tags: list[str]
    model_used: str | None
    fallback_used: bool
    error_message: str | None
    generated_at: str


def _serialize(insight: Any) -> GenerateInsightResponse:
    return GenerateInsightResponse(
        call_id=insight.callId,
        status=insight.status,
        summary=insight.summary,
        overall_sentiment=insight.overallSentiment,
        emotions=list(insight.emotions or []),
        sentiment_trend=insight.sentimentTrend,
        sentiment_confidence=float(insight.sentimentConfidence),
        service_concerns=insight.serviceConcerns
        if isinstance(insight.serviceConcerns, list)
        else (json.loads(insight.serviceConcerns) if insight.serviceConcerns else []),
        tags=insight.tags
        if isinstance(insight.tags, list)
        else (json.loads(insight.tags) if insight.tags else []),
        model_used=insight.modelUsed,
        fallback_used=insight.fallbackUsed,
        error_message=insight.errorMessage,
        generated_at=insight.generatedAt.isoformat(),
    )


def _coerce_sentiment(raw: Any) -> str:
    if isinstance(raw, str):
        normalized = raw.strip().upper()
        if normalized in {"POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"}:
            return normalized
    return "NEUTRAL"


def _coerce_trend(raw: Any) -> str:
    if isinstance(raw, str) and raw.strip().lower() in {
        "improving",
        "declining",
        "stable",
        "volatile",
    }:
        return raw.strip().lower()
    return "stable"


def _build_transcript(turns: list[Any]) -> str:
    lines: list[str] = []
    for t in turns:
        speaker = "AGENT" if t.speaker == "AGENT" else "USER"
        text = (t.utterance or "").strip()
        if not text:
            continue
        lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


@router.post("/insights/generate", response_model=GenerateInsightResponse)
@limiter.limit("30/minute")
async def generate_insight(
    body: GenerateInsightRequest, request: Request
) -> GenerateInsightResponse:
    log = get_logger(body.call_id)
    db = getattr(request.app.state, "db", None)
    if db is None or not db.is_connected():
        raise HTTPException(status_code=503, detail="Database unavailable")

    call = await db.call.find_unique(where={"callId": body.call_id})
    if call is None:
        raise HTTPException(status_code=404, detail="Call not found")

    existing = await db.callinsight.find_unique(where={"callId": body.call_id})
    if existing is not None and existing.status == "READY" and not body.regenerate:
        return _serialize(existing)

    turns = await db.callturn.find_many(
        where={"callId": body.call_id},
        order={"turnNumber": "asc"},
    )
    transcript = _build_transcript(turns)
    if not transcript:
        # Nothing to summarize — write a benign READY row so the UI doesn't
        # keep retrying on an empty call.
        empty_payload = {
            "status": "READY",
            "summary": "No transcript turns were recorded for this call.",
            "overallSentiment": "NEUTRAL",
            "emotions": [],
            "sentimentTrend": "stable",
            "sentimentConfidence": 0.0,
            "serviceConcerns": [],
            "tags": [],
            "modelUsed": None,
            "fallbackUsed": False,
            "errorMessage": None,
        }
        row = await db.callinsight.upsert(
            where={"callId": body.call_id},
            data={
                "create": {"callId": body.call_id, **empty_payload},
                "update": empty_payload,
            },
        )
        return _serialize(row)

    # Mark PENDING so concurrent viewers see "generating".
    pending_payload = {
        "status": "PENDING",
        "errorMessage": None,
    }
    await db.callinsight.upsert(
        where={"callId": body.call_id},
        data={
            "create": {"callId": body.call_id, **pending_payload},
            "update": pending_payload,
        },
    )

    model = settings.openai_classifier_model
    try:
        client = AsyncOpenAI(api_key=settings.llm_api_key)
        completion = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": transcript},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=600,
        )
        raw_content = completion.choices[0].message.content or "{}"
        parsed = json.loads(raw_content)
        prompt_tokens = (completion.usage.prompt_tokens if completion.usage else None)
        completion_tokens = (completion.usage.completion_tokens if completion.usage else None)
    except Exception as exc:  # noqa: BLE001 — top-level failure path
        log.error("insight_generation_failed", error_type=type(exc).__name__, message=str(exc))
        failed_payload = {
            "status": "FAILED",
            "errorMessage": f"{type(exc).__name__}: {exc}",
            "modelUsed": model,
        }
        row = await db.callinsight.upsert(
            where={"callId": body.call_id},
            data={
                "create": {"callId": body.call_id, **failed_payload},
                "update": failed_payload,
            },
        )
        return _serialize(row)

    summary = str(parsed.get("summary", "")).strip()
    sentiment = _coerce_sentiment(parsed.get("overall_sentiment"))
    trend = _coerce_trend(parsed.get("sentiment_trend"))
    raw_emotions = parsed.get("emotions") or []
    emotions = [str(e) for e in raw_emotions if isinstance(e, str)][:6]
    raw_concerns = parsed.get("service_concerns") or []
    service_concerns = [c for c in raw_concerns if isinstance(c, dict)]
    raw_tags = parsed.get("tags") or []
    tags = [str(t) for t in raw_tags if isinstance(t, str)][:12]
    try:
        confidence = float(parsed.get("sentiment_confidence", 0.5))
        confidence = max(0.0, min(1.0, confidence))
    except (TypeError, ValueError):
        confidence = 0.5

    payload = {
        "status": "READY",
        "summary": summary,
        "overallSentiment": sentiment,
        "emotions": emotions,
        "sentimentTrend": trend,
        "sentimentConfidence": confidence,
        "serviceConcerns": service_concerns,
        "tags": tags,
        "modelUsed": model,
        "fallbackUsed": False,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "errorMessage": None,
    }

    row = await db.callinsight.upsert(
        where={"callId": body.call_id},
        data={
            "create": {"callId": body.call_id, **payload},
            "update": payload,
        },
    )
    log.info(
        "insight_generated",
        sentiment=sentiment,
        trend=trend,
        tags=len(tags),
        concerns=len(service_concerns),
    )
    return _serialize(row)
