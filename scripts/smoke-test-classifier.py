#!/usr/bin/env python3
"""Quick smoke test: run a handful of utterances through the Pinecone classifier
and print top matches + the resulting vote. No FastAPI, no LLM fallback —
just exercises the new classifier path end-to-end against the live index.

Usage: uv run python scripts/smoke-test-classifier.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from app.services.objection_index import classify_via_pinecone, query_objections
from app.services.decision import Perception, decide
from app.models.requests import ObjectionType, ConversationStage


SAMPLES = [
    "that's way too expensive for me",
    "amazon has it cheaper",
    "I'm not sure if I can trust this brand",
    "let me think about it for a few days",
    "yeah let's go ahead and order",
    "uh, what does this even do",
    "hmm",
]


async def main() -> None:
    print("=" * 72)
    print("Pinecone classifier smoke test")
    print("=" * 72)
    for utt in SAMPLES:
        matches = await query_objections(utt, top_k=3)
        result = await classify_via_pinecone(utt, call_id="smoke")
        print(f"\nUtterance: {utt!r}")
        for i, m in enumerate(matches[:3], 1):
            print(
                f"  match #{i}: ({m.objection_type:16s} {m.sentiment:8s} subtype={m.subtype or '-':<18s})"
                f" score={m.score:.3f}  '{m.utterance}'"
            )
        if result is None:
            print("  -> NO VOTE (would fall back to LLM)")
        else:
            print(
                f"  -> {result.method.upper():9s} ({result.objection_type} "
                f"{result.sentiment} subtype={result.subtype}) confidence={result.confidence:.3f}"
            )
            # Run the decision rules engine on this perception (assume first
            # mention, neutral session for the smoke test).
            perception = Perception(
                objection_type=ObjectionType(result.objection_type),
                objection_subtype=result.subtype,
                sentiment=result.sentiment,
                stage=ConversationStage.PITCH,
                score=50,
                turn_count=3,
                prior_objection_types=[],
                discounts_offered=[],
                has_alternative_product=False,
            )
            decision = decide(perception)
            print(f"  -> tactic: {decision.tactic.value:24s}  reasoning: {decision.reasoning}")


if __name__ == "__main__":
    asyncio.run(main())
