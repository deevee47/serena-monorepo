#!/usr/bin/env python3
"""Interactive CLI for the converse pipeline.

Type customer responses; the agent reply (and any tool call) print live.
Each turn runs through the same code path as the live Vapi flow:
classifier-free converse() call → optional WhatsApp tool dispatch.

No telephony, no node-gateway, no DB — just exercises the brain in-process
so you can judge response quality fast.

Commands:
  /state           Print current session snapshot.
  /reset           Start over.
  /exit, /quit     Leave the CLI.

Usage:
  cd fastapi-brain && uv run python ../scripts/interactive-cli.py

Requires .env at repo root with OPENAI_API_KEY and PINECONE_API_KEY.
"""

import asyncio
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from app.models.requests import (
    CartContext,
    CartItem,
    ConversationTurn,
    ProductContext,
)
from app.services.converse_prompt_builder import build_converse_system_prompt
from app.services.llm import converse_response_stream
from app.services.prompt_sections import build_chat_messages
from app.services.tools import (
    OPENAI_TOOLS,
    ValidationError,
    parse_tool_call,
)


# ─── Hardcoded demo context ───────────────────────────────────────────────

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

ALTERNATIVE_PRODUCT = ProductContext(
    product_id="prod-002",
    name="ZephyrChair Lite",
    price=199.0,
    description="A simpler ergonomic chair, same family at a lower price point",
    key_features=[
        "2-position lumbar",
        "mesh back",
        "2-year warranty",
    ],
)

CART = CartContext(
    items=[
        CartItem(product_id="prod-001", name="ZephyrChair Pro", price=349.0),
        CartItem(product_id="acc-mat-01", name="Anti-fatigue Floor Mat", price=49.0),
    ],
    total=349.0 + 49.0,
    abandoned_minutes_ago=23,
)

CUSTOMER_PHONE = "+15551234567"


@dataclass
class Session:
    history: list[ConversationTurn] = field(default_factory=list)
    discounts_offered: list[int] = field(default_factory=list)
    last_tool: str | None = None

    def reset(self) -> None:
        self.history.clear()
        self.discounts_offered.clear()
        self.last_tool = None


# ─── WhatsApp demo (mirror of node-gateway/services/whatsapp.service.ts) ──

def _wa_checkout_link(discount_percent: int) -> str:
    final = PRODUCT.price * (1 - discount_percent / 100)
    tag = f" ({discount_percent}% off)" if discount_percent else ""
    url = f"https://shop.example/checkout/{PRODUCT.product_id}?d={discount_percent}"
    return f"Checkout — {PRODUCT.name}{tag}: ${final:.2f} | {url}"


def _wa_product_info() -> str:
    url = f"https://shop.example/product/{PRODUCT.product_id}"
    return f"{PRODUCT.name} — ${PRODUCT.price:.2f} | Details: {url} | Reach out anytime."


def _clamp_discount(raw) -> int:
    n = int(raw) if isinstance(raw, (int, float)) else 0
    return max(0, min(10, n))


def dispatch_tool(name: str, args: dict) -> tuple[str, dict] | None:
    """Mirror the node-gateway converse-dispatcher for the CLI demo. Returns
    (preview_string, applied_args) or None if the tool was skipped."""
    if name == "send_whatsapp_checkout_link":
        applied = {"discount_percent": _clamp_discount(args.get("discount_percent", 0))}
        return _wa_checkout_link(applied["discount_percent"]), applied
    if name == "send_whatsapp_product_info":
        return _wa_product_info(), {}
    return None


# ─── ANSI colors ──────────────────────────────────────────────────────────

C_DIM = "\033[2m"
C_GREEN = "\033[32m"
C_CYAN = "\033[36m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_BOLD = "\033[1m"
C_END = "\033[0m"


def banner() -> None:
    print(f"\n{C_BOLD}═══ Serena interactive CLI (converse pipeline) ═══{C_END}")
    print(f"  Product: {PRODUCT.name} (${PRODUCT.price:.2f})")
    print(f"  Alt:     {ALTERNATIVE_PRODUCT.name} (${ALTERNATIVE_PRODUCT.price:.2f})")
    print(f"  Cart:    {len(CART.items)} items, ${CART.total:.2f}, abandoned ~{CART.abandoned_minutes_ago} min ago")
    for item in CART.items:
        print(f"    - {item.name} (${item.price:.2f})")
    print(f"  Phone:   {CUSTOMER_PHONE} (whatsapp_available)")
    print(f"{C_DIM}  Type customer responses; agent replies stream live. /exit /reset /state{C_END}\n")


def print_state(session: Session) -> None:
    print(
        f"  {C_DIM}turns={len(session.history) // 2} "
        f"discounts_offered={session.discounts_offered} "
        f"last_tool={session.last_tool}{C_END}"
    )


# ─── Per-turn pipeline ────────────────────────────────────────────────────

async def turn(session: Session, utterance: str) -> None:
    system_prompt = build_converse_system_prompt(
        product_context=PRODUCT,
        alternative_product_context=ALTERNATIVE_PRODUCT,
        cart_context=CART,
        discounts_already_offered=session.discounts_offered,
    )
    messages = build_chat_messages(utterance=utterance, conversation_history=session.history)

    print(f"  {C_GREEN}agent →{C_END} ", end="", flush=True)

    text_chunks: list[str] = []
    pending_tool: dict | None = None
    finish_reason: str | None = None

    async for event in converse_response_stream(system_prompt, messages, OPENAI_TOOLS, "cli"):
        kind = event["type"]
        if kind == "text":
            delta = event["delta"]
            text_chunks.append(delta)
            print(delta, end="", flush=True)
        elif kind == "tool_call":
            pending_tool = {"name": event["name"], "args": event["args"]}
        elif kind == "done":
            finish_reason = event.get("finish_reason")
    print()  # newline after streaming text

    full_text = "".join(text_chunks).strip()

    # Validate any tool the LLM picked
    applied_tool: tuple[str, dict] | None = None
    if pending_tool:
        try:
            validated = parse_tool_call(pending_tool["name"], pending_tool["args"])
            applied_tool = (validated.name, validated.args)
        except (ValidationError, ValueError) as exc:
            print(f"  {C_RED}tool dropped (invalid):{C_END} {pending_tool['name']} {pending_tool['args']} — {exc}")

    if applied_tool:
        name, args = applied_tool
        dispatch = dispatch_tool(name, args)
        if dispatch:
            preview, applied_args = dispatch
            arg_str = ", ".join(f"{k}={v}" for k, v in applied_args.items())
            print(f"  {C_YELLOW}tool   →{C_END} {name}({arg_str})")
            print(f"  {C_CYAN}[DEMO whatsapp → {CUSTOMER_PHONE}] {preview}{C_END}")
            session.last_tool = name
            # Track checkout-link discount so the next prompt skips that tier.
            if name == "send_whatsapp_checkout_link":
                d = applied_args.get("discount_percent", 0)
                if d > 0 and d not in session.discounts_offered:
                    session.discounts_offered.append(d)

    if finish_reason and finish_reason not in ("stop", "tool_calls"):
        print(f"  {C_DIM}finish_reason={finish_reason}{C_END}")

    session.history.append(ConversationTurn(speaker="USER", utterance=utterance, timestamp=""))
    session.history.append(ConversationTurn(speaker="AGENT", utterance=full_text, timestamp=""))


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
