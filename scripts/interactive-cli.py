#!/usr/bin/env python3
"""Interactive CLI for the converse pipeline.

Loads a demo customer + their abandoned cart from the seeded database
(scripts/seed-demo-data.ts), then drops you into a chat with the agent.
Each turn runs the full converse pipeline: classifier-free LLM call with
observation tools (check_inventory, get_recent_purchases, get_review_summary,
get_delivery_eta) executed server-side, plus side-effect tools (WhatsApp
checkout / product-info) dispatched to the demo logger.

Commands:
  /state              Print session snapshot.
  /reset              Start over (same customer).
  /switch <phone>     Switch customer (e.g. /switch +15552223333).
  /list               List the demo customers from the seed.
  /exit, /quit        Leave.

Usage:
  cd fastapi-brain && uv run python ../scripts/interactive-cli.py
  # or pick a specific customer up front:
  uv run python ../scripts/interactive-cli.py +15557778888

Requires .env at repo root with OPENAI_API_KEY, PINECONE_API_KEY, DATABASE_URL.
"""

import asyncio
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from prisma import Prisma

from app.models.requests import (
    CartContext,
    CartItem,
    ConversationTurn,
    CustomerContext,
    CustomerSegment,
    PastOrderSummary,
    ProductContext,
)
from app.services.converse_prompt_builder import build_converse_system_prompt
from app.services.llm import converse_response_stream
from app.services.observations import execute_observation_tool
from app.services.prompt_sections import build_chat_messages
from app.services.tools import (
    OPENAI_TOOLS,
    ValidationError,
    parse_tool_call,
)


DEFAULT_PHONE = "+15551234567"  # Sarah Chen, RETURNING — see seed-demo-data.ts


# ─── ANSI ─────────────────────────────────────────────────────────────────

C_DIM = "\033[2m"
C_GREEN = "\033[32m"
C_CYAN = "\033[36m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_BOLD = "\033[1m"
C_END = "\033[0m"


# ─── Session state ────────────────────────────────────────────────────────


@dataclass
class Session:
    history: list[ConversationTurn] = field(default_factory=list)
    discounts_offered: list[int] = field(default_factory=list)
    last_tool: str | None = None

    def reset(self) -> None:
        self.history.clear()
        self.discounts_offered.clear()
        self.last_tool = None


# ─── DB lookups (call once per customer change, not per turn) ─────────────


async def load_customer_and_cart(
    db: Prisma, phone: str
) -> tuple[CustomerContext | None, CartContext | None, ProductContext | None, ProductContext | None]:
    """Returns (customer_context, cart_context, primary_product, alternative_product)."""
    customer = await db.customer.find_unique(where={"phone": phone})
    if customer is None:
        return None, None, None, None

    purchases = await db.purchase.find_many(
        where={"customerId": customer.id},
        order={"purchasedAt": "desc"},
        take=5,
        include={"product": True},
    )
    past_orders = []
    now = datetime.now(timezone.utc)
    for p in purchases:
        if p.product is None:
            continue
        days = max(0, (now - p.purchasedAt).days)
        past_orders.append(
            PastOrderSummary(
                product_id=p.product.id,
                product_name=p.product.name,
                price=float(p.price),
                days_ago=days,
            )
        )

    customer_ctx = CustomerContext(
        phone=customer.phone,
        name=customer.name,
        email=customer.email,
        segment=CustomerSegment(customer.segment),
        lifetime_value=float(customer.lifetimeValue),
        prior_calls_count=customer.priorCallsCount,
        timezone=customer.timezone,
        preferred_contact=customer.preferredContact,
        past_orders=past_orders,
    )

    cart = await db.cart.find_first(
        where={"customerId": customer.id, "status": "ABANDONED"},
        order={"abandonedAt": "desc"},
        include={"items": {"include": {"product": True}}},
    )
    if cart is None or not cart.items:
        return customer_ctx, None, None, None

    cart_items: list[CartItem] = []
    total = 0.0
    primary_product: ProductContext | None = None
    for item in cart.items:
        if item.product is None:
            continue
        cart_items.append(
            CartItem(
                product_id=item.product.id,
                name=item.product.name,
                price=float(item.priceAtAdd),
                quantity=item.quantity,
            )
        )
        total += float(item.priceAtAdd) * item.quantity
        if primary_product is None:
            primary_product = ProductContext(
                product_id=item.product.id,
                name=item.product.name,
                price=float(item.product.price),
                description=item.product.description or "",
                key_features=item.product.tags,
            )

    abandoned_minutes = None
    if cart.abandonedAt is not None:
        delta = now - cart.abandonedAt
        abandoned_minutes = int(delta.total_seconds() / 60)

    cart_ctx = CartContext(
        items=cart_items,
        total=round(total, 2),
        abandoned_minutes_ago=abandoned_minutes,
    )

    # Best-effort alternative: cheaper product in the same category
    alt_product: ProductContext | None = None
    if primary_product is not None:
        primary_db = await db.product.find_unique(where={"id": primary_product.product_id})
        if primary_db and primary_db.category:
            alt_db = await db.product.find_first(
                where={
                    "category": primary_db.category,
                    "isActive": True,
                    "id": {"not": primary_product.product_id},
                    "price": {"lt": primary_db.price},
                },
                order={"price": "desc"},
            )
            if alt_db:
                alt_product = ProductContext(
                    product_id=alt_db.id,
                    name=alt_db.name,
                    price=float(alt_db.price),
                    description=alt_db.description or "",
                    key_features=alt_db.tags,
                )

    return customer_ctx, cart_ctx, primary_product, alt_product


# ─── WhatsApp demo (mirror of node-gateway whatsapp.service.ts) ───────────


def _wa_checkout_link(product: ProductContext, discount_percent: int) -> str:
    final = product.price * (1 - discount_percent / 100)
    tag = f" ({discount_percent}% off)" if discount_percent else ""
    url = f"https://shop.example/checkout/{product.product_id}?d={discount_percent}"
    return f"Checkout — {product.name}{tag}: ${final:.2f} | {url}"


def _wa_product_info(product: ProductContext) -> str:
    url = f"https://shop.example/product/{product.product_id}"
    return f"{product.name} — ${product.price:.2f} | Details: {url} | Reach out anytime."


def _clamp_discount(raw) -> int:
    n = int(raw) if isinstance(raw, (int, float)) else 0
    return max(0, min(10, n))


def dispatch_side_effect_tool(
    name: str, args: dict, product: ProductContext, customer: CustomerContext
) -> tuple[str, dict] | None:
    if name == "send_whatsapp_checkout_link":
        applied = {"discount_percent": _clamp_discount(args.get("discount_percent", 0))}
        return _wa_checkout_link(product, applied["discount_percent"]), applied
    if name == "send_whatsapp_product_info":
        return _wa_product_info(product), {}
    return None


# ─── Banners ──────────────────────────────────────────────────────────────


def banner(customer: CustomerContext, cart: CartContext | None,
           product: ProductContext | None, alt: ProductContext | None) -> None:
    print(f"\n{C_BOLD}═══ Serena interactive CLI (converse pipeline) ═══{C_END}")
    print(f"  Customer: {customer.name or '(no name)'} ({customer.phone})")
    print(f"            segment={customer.segment.value} ltv=${customer.lifetime_value:.2f} "
          f"timezone={customer.timezone or '?'} prefer={customer.preferred_contact or '?'}")
    if customer.past_orders:
        print(f"  Past orders ({len(customer.past_orders)}):")
        for o in customer.past_orders[:3]:
            print(f"    - {o.product_name} (${o.price:.2f}) ~{o.days_ago}d ago")
    if cart and cart.items:
        print(f"  Cart: {len(cart.items)} items, ${cart.total:.2f}, abandoned ~{cart.abandoned_minutes_ago} min ago")
        for item in cart.items:
            print(f"    - {item.name} (${item.price:.2f})")
    if alt:
        print(f"  Alt:  {alt.name} (${alt.price:.2f})")
    print(f"{C_DIM}  Type customer responses; agent streams live. /exit /reset /switch <phone> /list /state{C_END}\n")


async def list_customers(db: Prisma) -> None:
    customers = await db.customer.find_many(order={"name": "asc"})
    print(f"\n{C_BOLD}Demo customers:{C_END}")
    for c in customers:
        print(f"  {c.phone:<16} {c.name or '(no name)':<25} segment={c.segment} ltv=${float(c.lifetimeValue):.2f}")
    print()


# ─── Per-turn pipeline ────────────────────────────────────────────────────


async def turn(
    db: Prisma,
    session: Session,
    utterance: str,
    customer: CustomerContext,
    cart: CartContext | None,
    product: ProductContext | None,
    alt: ProductContext | None,
) -> None:
    system_prompt = build_converse_system_prompt(
        product_context=product,
        alternative_product_context=alt,
        cart_context=cart,
        customer_context=customer,
        discounts_already_offered=session.discounts_offered,
    )
    messages = build_chat_messages(utterance=utterance, conversation_history=session.history)

    async def runner(name: str, args: dict) -> dict:
        try:
            validated = parse_tool_call(name, args)
        except (ValidationError, ValueError) as exc:
            return {"error": "invalid_args", "detail": str(exc)}
        return await execute_observation_tool(db, validated.name, validated.args)

    print(f"  {C_GREEN}agent →{C_END} ", end="", flush=True)

    text_chunks: list[str] = []
    pending_side_effect: dict | None = None

    async for event in converse_response_stream(
        system_prompt, messages, OPENAI_TOOLS, "cli", run_observation_tool=runner,
    ):
        kind = event["type"]
        if kind == "text":
            delta = event["delta"]
            text_chunks.append(delta)
            print(delta, end="", flush=True)
        elif kind == "observation":
            # Print on a new line so it doesn't clobber the streaming text
            name = event["name"]
            args = event["args"]
            res = event["result"]
            print()
            print(f"  {C_DIM}observe →{C_END} {name}({args}) → {_short_result(res)}")
            print(f"  {C_GREEN}agent →{C_END} ", end="", flush=True)
        elif kind == "tool_call":
            pending_side_effect = {"name": event["name"], "args": event["args"]}
        elif kind == "done":
            pass
    print()

    full_text = "".join(text_chunks).strip()

    # Dispatch side-effect tool (WhatsApp)
    if pending_side_effect and product:
        try:
            validated = parse_tool_call(pending_side_effect["name"], pending_side_effect["args"])
        except (ValidationError, ValueError) as exc:
            print(f"  {C_RED}tool dropped (invalid):{C_END} {pending_side_effect['name']} — {exc}")
        else:
            dispatch = dispatch_side_effect_tool(validated.name, validated.args, product, customer)
            if dispatch:
                preview, applied_args = dispatch
                arg_str = ", ".join(f"{k}={v}" for k, v in applied_args.items())
                print(f"  {C_YELLOW}tool   →{C_END} {validated.name}({arg_str})")
                print(f"  {C_CYAN}[DEMO whatsapp → {customer.phone}] {preview}{C_END}")
                session.last_tool = validated.name
                if validated.name == "send_whatsapp_checkout_link":
                    d = applied_args.get("discount_percent", 0)
                    if d > 0 and d not in session.discounts_offered:
                        session.discounts_offered.append(d)

    session.history.append(ConversationTurn(speaker="USER", utterance=utterance, timestamp=""))
    session.history.append(ConversationTurn(speaker="AGENT", utterance=full_text, timestamp=""))


def _short_result(result: dict) -> str:
    """One-line preview of the observation result for terminal display."""
    items = []
    for k, v in result.items():
        if isinstance(v, str) and len(v) > 40:
            v = v[:37] + "..."
        items.append(f"{k}={v}")
    return "{" + ", ".join(items) + "}"


def print_state(session: Session, customer: CustomerContext) -> None:
    print(
        f"  {C_DIM}customer={customer.name} ({customer.phone}) "
        f"turns={len(session.history) // 2} "
        f"discounts_offered={session.discounts_offered} "
        f"last_tool={session.last_tool}{C_END}"
    )


# ─── Main ──────────────────────────────────────────────────────────────────


async def main() -> None:
    initial_phone = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PHONE

    db = Prisma()
    await db.connect()
    try:
        customer, cart, product, alt = await load_customer_and_cart(db, initial_phone)
        if customer is None:
            print(f"{C_RED}Customer not found for phone {initial_phone}.{C_END}")
            print(f"{C_DIM}Run `bun run scripts/seed-demo-data.ts` then try /list to see available customers.{C_END}")
            return

        banner(customer, cart, product, alt)
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
                print_state(session, customer)
                continue
            if line == "/list":
                await list_customers(db)
                continue
            if line.startswith("/switch "):
                new_phone = line[len("/switch "):].strip()
                new_customer, new_cart, new_product, new_alt = await load_customer_and_cart(db, new_phone)
                if new_customer is None:
                    print(f"  {C_RED}no customer with phone {new_phone}{C_END}")
                    continue
                customer, cart, product, alt = new_customer, new_cart, new_product, new_alt
                session = Session()
                banner(customer, cart, product, alt)
                continue
            try:
                await turn(db, session, line, customer, cart, product, alt)
            except Exception as exc:  # noqa: BLE001
                print(f"  {C_RED}error:{C_END} {type(exc).__name__}: {exc}")
    finally:
        await db.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
