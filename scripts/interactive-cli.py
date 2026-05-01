#!/usr/bin/env python3
"""Interactive CLI: type your customer responses, see the agent reply.

Runs the full conversion-engine pipeline locally without telephony, the
node-gateway, or a database. Type a customer line at the prompt and watch:
  - what the classifier saw (objection_type, sentiment, subtype, confidence)
  - what tactic the rules engine picked, and why
  - the agent's natural-language reply (real LLM call)
  - any tool the tactic triggered (e.g. WhatsApp checkout link demo)

Commands:
  /state           Print current session state.
  /reset           Start a fresh session.
  /exit, /quit     Leave the CLI.

Usage:
  cd fastapi-brain && uv run python ../scripts/interactive-cli.py

Requires the .env at repo root to have OPENAI_API_KEY and PINECONE_API_KEY.
"""
import asyncio
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# Force Pinecone mode in the CLI so subtype-driven rules (incl. WhatsApp
# routing on ready_to_buy) actually fire. The default 'shadow' mode discards
# subtypes by always returning the LLM result. Override via CLI env if you
# want shadow / llm mode for comparison.
os.environ.setdefault("CLASSIFIER_MODE", "pinecone")

from app.models.requests import (
    ConversationStage,
    ConversationTurn,
    ObjectionType,
    ProductContext,
)
from app.services.classifier import classify_objection
from app.services.decision import Perception, decide
from app.services.llm import generate_response
from app.services.signals import SignalSnapshot, filler_density, utterance_length_trend
from app.services.speech_prompt_builder import (
    build_speech_messages,
    build_speech_system_prompt,
)


# ─── Config you might tweak ───────────────────────────────────────────────────

PRODUCT = ProductContext(
    product_id="prod-001",
    name="ZephyrChair Pro",
    price=349.0,
    description="An ergonomic office chair with lumbar support",
    key_features=[
        "3D-adjustable lumbar",
        "breathable mesh back",
        "5-year warranty",
    ],
)

CUSTOMER_PHONE = "+15551234567"  # for the WhatsApp demo log


# ─── Session state ────────────────────────────────────────────────────────────

@dataclass
class Session:
    stage: ConversationStage = ConversationStage.INTRO
    score: int = 50
    turn_count: int = 0
    prior_objections: list[ObjectionType] = field(default_factory=list)
    discounts_offered: list[int] = field(default_factory=list)
    history: list[ConversationTurn] = field(default_factory=list)
    last_tactic: str | None = None
    last_subtype: str | None = None

    def reset(self) -> None:
        self.stage = ConversationStage.INTRO
        self.score = 50
        self.turn_count = 0
        self.prior_objections = []
        self.discounts_offered = []
        self.history = []
        self.last_tactic = None
        self.last_subtype = None


# Score deltas mirror node-gateway/scoring.service.ts defaults so the CLI
# behaves like a real call without needing the DB-backed config.
SCORE_DELTAS = {
    ObjectionType.PRICE: -15,
    ObjectionType.TRUST: -20,
    ObjectionType.CONFUSION: -10,
    ObjectionType.TIMING: -12,
    ObjectionType.POSITIVE_SIGNAL: 12,
    ObjectionType.NEUTRAL: 0,
}


def update_score(session: Session, otype: str, sentiment: str) -> int:
    delta = SCORE_DELTAS.get(ObjectionType(otype), 0)
    if sentiment == "POSITIVE" and delta < 0:
        delta = max(-1, delta // 2)
    if ObjectionType(otype) in session.prior_objections and delta < 0:
        delta -= 10  # repeat penalty
    return max(0, min(100, session.score + delta))


def advance_stage(session: Session, otype: str, sentiment: str) -> ConversationStage:
    """Tiny FSM mirroring node-gateway/stage.service.ts in spirit (not byte-for-byte)."""
    if session.score < 20 and session.turn_count >= 3:
        return ConversationStage.END
    if sentiment == "POSITIVE" and session.score >= 60 and session.turn_count >= 4:
        return ConversationStage.CLOSE
    if otype in {"PRICE"} and session.stage in {ConversationStage.PITCH, ConversationStage.OBJECTION}:
        return ConversationStage.NEGOTIATION
    if otype in {"TRUST", "TIMING", "CONFUSION"} and session.stage == ConversationStage.PITCH:
        return ConversationStage.OBJECTION
    if session.stage == ConversationStage.INTRO and session.turn_count > 0:
        return ConversationStage.PITCH
    return session.stage


def recent_user_utterances(session: Session, current: str) -> list[str]:
    user = [t.utterance for t in session.history if t.speaker == "USER"]
    return (user + [current])[-5:]


def simulate_whatsapp(tactic: str, discount: int) -> str:
    if tactic == "SEND_CHECKOUT_LINK_WHATSAPP":
        final = PRODUCT.price * (1 - discount / 100)
        tag = f" ({discount}% off)" if discount else ""
        url = f"https://shop.example/checkout/{PRODUCT.product_id}?d={discount}"
        return f"[DEMO whatsapp → {CUSTOMER_PHONE}] Checkout — {PRODUCT.name}{tag}: ${final:.2f} | {url}"
    if tactic == "SEND_PRODUCT_INFO_WHATSAPP":
        url = f"https://shop.example/product/{PRODUCT.product_id}"
        return f"[DEMO whatsapp → {CUSTOMER_PHONE}] {PRODUCT.name} — ${PRODUCT.price:.2f} | Details: {url} | Reach out anytime."
    return ""


# ─── Pretty-printing helpers ─────────────────────────────────────────────────

C_DIM = "\033[2m"
C_GREEN = "\033[32m"
C_CYAN = "\033[36m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_BOLD = "\033[1m"
C_END = "\033[0m"


def banner() -> None:
    print(f"\n{C_BOLD}═══ Serena interactive CLI ═══{C_END}")
    print(f"  Product: {PRODUCT.name} (${PRODUCT.price:.2f})")
    print(f"  Phone:   {CUSTOMER_PHONE} (whatsapp_available=True)")
    print(f"{C_DIM}  Type customer responses; agent replies in real time. /exit, /reset, /state.{C_END}\n")


# ─── Main loop ───────────────────────────────────────────────────────────────

async def turn(session: Session, utterance: str) -> None:
    classification = await classify_objection(utterance, str(session.stage), session.score, "cli")
    print(
        f"  {C_DIM}classifier:{C_END} {classification.objection_type} {classification.sentiment} "
        f"subtype={classification.subtype or '-'} conf={classification.confidence:.2f}"
    )

    new_score = update_score(session, classification.objection_type, classification.sentiment)
    next_stage = advance_stage(session, classification.objection_type, classification.sentiment)

    discount_available = 0
    if next_stage in (ConversationStage.OBJECTION, ConversationStage.NEGOTIATION):
        if classification.objection_type == "PRICE":
            ladder = [5, 10]
            if len(session.discounts_offered) < len(ladder):
                discount_available = ladder[len(session.discounts_offered)]

    user_utts = recent_user_utterances(session, utterance)
    perception = Perception(
        objection_type=ObjectionType(classification.objection_type),
        objection_subtype=classification.subtype,
        sentiment=classification.sentiment,
        stage=next_stage,
        score=new_score,
        turn_count=session.turn_count,
        prior_objection_types=list(session.prior_objections),
        discounts_offered=list(session.discounts_offered),
        has_alternative_product=False,
        signals=SignalSnapshot(
            utterance_length_trend=utterance_length_trend(user_utts),
            filler_density=filler_density(user_utts),
        ),
        whatsapp_available=True,
    )
    decision = decide(perception)
    print(f"  {C_DIM}decide:{C_END}     {C_YELLOW}{decision.tactic.value}{C_END} — {decision.reasoning}")

    system_prompt = build_speech_system_prompt(
        tactic=decision.tactic.value,
        micro_guidance=decision.micro_guidance,
        product_context=PRODUCT,
        discount_available=discount_available,
    )
    messages = build_speech_messages(utterance=utterance, conversation_history=session.history)
    reply = (await generate_response(system_prompt, messages, "cli")).strip()
    print(f"  {C_GREEN}agent →{C_END} {reply}")

    wa_log = simulate_whatsapp(decision.tactic.value, discount_available)
    if wa_log:
        print(f"  {C_CYAN}{wa_log}{C_END}")

    # Update session state for the next turn.
    session.history.append(ConversationTurn(speaker="USER", utterance=utterance, timestamp=""))
    session.history.append(ConversationTurn(speaker="AGENT", utterance=reply, timestamp=""))
    session.prior_objections.append(ObjectionType(classification.objection_type))
    session.score = new_score
    session.stage = next_stage
    session.turn_count += 1
    session.last_tactic = decision.tactic.value
    session.last_subtype = classification.subtype
    if discount_available and decision.tactic.value in {"CONCESSION_REAL", "SEND_CHECKOUT_LINK_WHATSAPP"}:
        session.discounts_offered.append(discount_available)


def print_state(session: Session) -> None:
    print(f"  {C_DIM}stage={session.stage} score={session.score} turn={session.turn_count} "
          f"discounts={session.discounts_offered} prior_objs={[o.value for o in session.prior_objections]} "
          f"last_tactic={session.last_tactic}{C_END}")


async def main() -> None:
    banner()
    session = Session()
    while True:
        try:
            line = input(f"{C_BOLD}you ›{C_END} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        if line in {"/exit", "/quit"}:
            break
        if line == "/reset":
            session.reset()
            print(f"  {C_DIM}session reset{C_END}")
            continue
        if line == "/state":
            print_state(session)
            continue
        try:
            await turn(session, line)
        except Exception as exc:  # noqa: BLE001
            print(f"  {C_RED}error:{C_END} {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    asyncio.run(main())
