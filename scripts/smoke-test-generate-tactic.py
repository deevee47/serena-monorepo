#!/usr/bin/env python3
"""End-to-end smoke test of the new tactic-driven generation path.

Pipeline per utterance:
  Pinecone classifier → vote → Decision rules → tactic + micro_guidance
                                              → speech prompt → LLM → response

Demonstrates the full natural-manipulator pipeline: a tiny prompt + a named
tactic produces voice-natural responses without persona theatre.

Usage: uv run python scripts/smoke-test-generate-tactic.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from app.models.requests import ConversationStage, ConversationTurn, ObjectionType, ProductContext
from app.services.classifier import classify_objection
from app.services.decision import Perception, decide
from app.services.llm import generate_response
from app.services.speech_prompt_builder import build_speech_messages, build_speech_system_prompt


PRODUCT = ProductContext(
    product_id="prod-001",
    name="ZephyrChair Pro",
    price=349.0,
    description="An ergonomic office chair with lumbar support",
    key_features=["3D-adjustable lumbar", "breathable mesh back", "5-year warranty"],
)

ALT_PRODUCT = ProductContext(
    product_id="prod-002",
    name="ZephyrChair Lite",
    price=199.0,
    description="A simpler ergonomic chair",
    key_features=["2-position lumbar", "mesh back", "2-year warranty"],
)


SCENARIOS = [
    # (label, utterance, prior_objections, discounts_offered, has_alt, history)
    ("first PRICE objection", "that's way too expensive for me", [], [], False, []),
    ("repeated PRICE with alt available", "still too pricey", [ObjectionType.PRICE], [], True, []),
    ("strong buying signal",  "yeah let's do this", [], [], False, [
        ConversationTurn(speaker="USER", utterance="how does delivery work", timestamp="2026-01-01T00:00:00Z"),
        ConversationTurn(speaker="AGENT", utterance="overnight to most US zips, signature on delivery", timestamp="2026-01-01T00:00:01Z"),
    ]),
    ("first TRUST objection", "I don't really trust new brands", [], [], False, []),
    ("backchannel mid-pitch", "hmm", [], [], False, []),
]


async def run_scenario(label: str, utterance: str, prior_objections, discounts, has_alt, history) -> None:
    print(f"\n{'─' * 72}")
    print(f"Scenario: {label}")
    print(f"  customer says: {utterance!r}")

    classification = await classify_objection(utterance, "PITCH", 50, "smoke")
    print(f"  classified: {classification.objection_type} {classification.sentiment} subtype={classification.subtype} confidence={classification.confidence:.3f}")

    perception = Perception(
        objection_type=ObjectionType(classification.objection_type) if classification.objection_type else None,
        objection_subtype=classification.subtype,
        sentiment=classification.sentiment,
        stage=ConversationStage.PITCH,
        score=50,
        turn_count=len(history) + 1,
        prior_objection_types=prior_objections,
        discounts_offered=discounts,
        has_alternative_product=has_alt,
    )
    decision = decide(perception)
    print(f"  decided: {decision.tactic.value}  reasoning: {decision.reasoning}")

    system_prompt = build_speech_system_prompt(
        tactic=decision.tactic.value,
        micro_guidance=decision.micro_guidance,
        product_context=PRODUCT,
        alternative_product_context=ALT_PRODUCT if has_alt else None,
        discount_available=5 if decision.tactic.value == "CONCESSION_REAL" else 0,
    )
    messages = build_speech_messages(utterance=utterance, conversation_history=history)
    print(f"  speech-prompt size: {len(system_prompt)} chars (~{len(system_prompt)//4} tokens)")

    response = await generate_response(system_prompt, messages, "smoke")
    print(f"  agent says: {response.strip()!r}")


async def main() -> None:
    print("=" * 72)
    print("End-to-end smoke test: classifier → decision → tactic-driven generation")
    print("=" * 72)
    for sc in SCENARIOS:
        await run_scenario(*sc)


if __name__ == "__main__":
    asyncio.run(main())
