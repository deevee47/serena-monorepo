#!/usr/bin/env python3
"""Eval runner for the converse pipeline.

Drives canonical conversation scenarios from eval/scenarios.jsonl through the
real LLM (with real customer/cart context loaded from the seeded DB), captures
agent responses + tool calls, and applies two layers of scoring per scenario:

1. **Heuristic checks** from the scenario fixture itself — exact pass/fail
   on testable invariants (right tool fired, forbidden phrase not used, etc.)
2. **LLM judge** — gpt-4o-mini scores 1-5 on whether the agent did the right
   thing for the goal, with one-sentence reasoning.

Output: a per-scenario JSON file under eval-results/{timestamp}.json plus a
summary table to stdout.

Usage:
  cd fastapi-brain && uv run python ../scripts/run-eval.py
  uv run python ../scripts/run-eval.py --scenario ready_to_buy_immediate
  uv run python ../scripts/run-eval.py --judge-model gpt-4o-mini
"""

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fastapi-brain"))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from openai import AsyncOpenAI
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
from app.services.tools import OPENAI_TOOLS, ValidationError, parse_tool_call


REPO_ROOT = Path(__file__).resolve().parent.parent
SCENARIOS_PATH = REPO_ROOT / "fastapi-brain" / "eval" / "scenarios.jsonl"
RESULTS_DIR = REPO_ROOT / "eval-results"


# ─── Types ────────────────────────────────────────────────────────────────


@dataclass
class TurnResult:
    customer: str
    agent_text: str
    observations: list[dict] = field(default_factory=list)
    side_effect_tool: dict | None = None


@dataclass
class HeuristicResult:
    name: str
    passed: bool
    detail: str


@dataclass
class JudgeResult:
    score: int
    reasoning: str


@dataclass
class ScenarioResult:
    id: str
    description: str
    customer_phone: str
    turns: list[TurnResult]
    heuristics: list[HeuristicResult]
    judge: JudgeResult | None
    error: str | None = None
    duration_ms: int = 0

    @property
    def heuristic_passed(self) -> bool:
        return all(h.passed for h in self.heuristics)


# ─── DB lookup (mirrors interactive-cli.py) ───────────────────────────────


async def load_customer_and_cart(db: Prisma, phone: str):
    customer = await db.customer.find_unique(where={"phone": phone})
    if customer is None:
        return None, None, None, None

    purchases = await db.purchase.find_many(
        where={"customerId": customer.id},
        order={"purchasedAt": "desc"},
        take=5,
        include={"product": True},
    )
    past_orders: list[PastOrderSummary] = []
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
        items=cart_items, total=round(total, 2), abandoned_minutes_ago=abandoned_minutes
    )

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


# ─── Run a scenario ───────────────────────────────────────────────────────


async def run_scenario(db: Prisma, scenario: dict) -> ScenarioResult:
    sid = scenario["id"]
    customer, cart, product, alt = await load_customer_and_cart(db, scenario["customer_phone"])
    if customer is None:
        return ScenarioResult(
            id=sid, description=scenario["description"], customer_phone=scenario["customer_phone"],
            turns=[], heuristics=[], judge=None, error="customer_not_found",
        )

    history: list[ConversationTurn] = []
    discounts_offered: list[int] = []
    turn_results: list[TurnResult] = []
    last_side_effect: dict | None = None
    start = time.perf_counter()

    async def runner(name: str, args: dict) -> dict:
        try:
            v = parse_tool_call(name, args)
        except (ValidationError, ValueError) as exc:
            return {"error": "invalid_args", "detail": str(exc)}
        return await execute_observation_tool(db, v.name, v.args)

    for turn in scenario["turns"]:
        utterance = turn["customer"]
        system_prompt = build_converse_system_prompt(
            product_context=product,
            alternative_product_context=alt,
            cart_context=cart,
            customer_context=customer,
            discounts_already_offered=discounts_offered,
        )
        messages = build_chat_messages(utterance=utterance, conversation_history=history)

        text_chunks: list[str] = []
        observations: list[dict] = []
        side_effect: dict | None = None

        async for event in converse_response_stream(
            system_prompt, messages, OPENAI_TOOLS, f"eval-{sid}", run_observation_tool=runner,
        ):
            kind = event["type"]
            if kind == "text":
                text_chunks.append(event["delta"])
            elif kind == "observation":
                observations.append({"name": event["name"], "args": event["args"], "result": event["result"]})
            elif kind == "tool_call":
                # Validate args same as the route does
                try:
                    v = parse_tool_call(event["name"], event["args"])
                    side_effect = {"name": v.name, "args": v.args}
                except (ValidationError, ValueError):
                    pass

        agent_text = "".join(text_chunks).strip()
        turn_results.append(TurnResult(
            customer=utterance, agent_text=agent_text,
            observations=observations, side_effect_tool=side_effect,
        ))
        history.append(ConversationTurn(speaker="USER", utterance=utterance, timestamp=""))
        history.append(ConversationTurn(speaker="AGENT", utterance=agent_text, timestamp=""))
        if side_effect:
            last_side_effect = side_effect
            if side_effect["name"] == "send_whatsapp_checkout_link":
                d = side_effect["args"].get("discount_percent", 0)
                if d > 0 and d not in discounts_offered:
                    discounts_offered.append(d)

    duration_ms = int((time.perf_counter() - start) * 1000)
    heuristics = check_heuristics(scenario, turn_results, last_side_effect)
    return ScenarioResult(
        id=sid, description=scenario["description"], customer_phone=scenario["customer_phone"],
        turns=turn_results, heuristics=heuristics, judge=None, duration_ms=duration_ms,
    )


# ─── Heuristic checks ─────────────────────────────────────────────────────


def check_heuristics(scenario: dict, turns: list[TurnResult], last_side_effect: dict | None) -> list[HeuristicResult]:
    results: list[HeuristicResult] = []
    last_text = turns[-1].agent_text.lower() if turns else ""
    all_text = " ".join(t.agent_text.lower() for t in turns)
    all_observations = [o["name"] for t in turns for o in t.observations]

    if "expected_tool" in scenario:
        want = scenario["expected_tool"]
        got = last_side_effect["name"] if last_side_effect else None
        results.append(HeuristicResult(
            name=f"expected_tool={want}",
            passed=got == want,
            detail=f"got={got}",
        ))

    if "expected_discount_max" in scenario and last_side_effect:
        cap = scenario["expected_discount_max"]
        actual = last_side_effect["args"].get("discount_percent", 0)
        results.append(HeuristicResult(
            name=f"discount<=max({cap})",
            passed=actual <= cap,
            detail=f"actual={actual}",
        ))

    if scenario.get("expected_no_tool_until_close"):
        # Last turn shouldn't have called a side-effect tool
        results.append(HeuristicResult(
            name="no_side_effect_tool_yet",
            passed=last_side_effect is None,
            detail=f"last_tool={last_side_effect['name'] if last_side_effect else None}",
        ))

    if scenario.get("expected_no_close_tool"):
        # Should NOT have called the checkout link
        called_close = any(
            t.side_effect_tool and t.side_effect_tool["name"] == "send_whatsapp_checkout_link"
            for t in turns
        )
        results.append(HeuristicResult(
            name="no_checkout_link_pushed",
            passed=not called_close,
            detail="called_checkout" if called_close else "ok",
        ))

    if "expected_observation_tool" in scenario:
        want = scenario["expected_observation_tool"]
        results.append(HeuristicResult(
            name=f"used_observation_tool={want}",
            passed=want in all_observations,
            detail=f"observed={all_observations}",
        ))

    if "allowed_observation_tool" in scenario:
        # Either the allowed tool was used OR the agent admitted not knowing
        # (avoiding fake claims). We pass if the forbidden phrases aren't present.
        want = scenario["allowed_observation_tool"]
        used_allowed = want in all_observations
        results.append(HeuristicResult(
            name=f"may_have_used={want}",
            passed=True,  # informational only
            detail=f"used={used_allowed}",
        ))

    if "expected_text_contains_any" in scenario:
        needles = [n.lower() for n in scenario["expected_text_contains_any"]]
        found = any(n in all_text for n in needles)
        results.append(HeuristicResult(
            name="contains_any",
            passed=found,
            detail=f"needles={needles}, last_text=...{last_text[-120:]}",
        ))

    if "expected_text_not_contains_any" in scenario:
        forbidden = [n.lower() for n in scenario["expected_text_not_contains_any"]]
        violations = [n for n in forbidden if n in all_text]
        results.append(HeuristicResult(
            name="not_contains_any",
            passed=not violations,
            detail=f"violations={violations}" if violations else "ok",
        ))

    return results


# ─── LLM judge ────────────────────────────────────────────────────────────


JUDGE_SYSTEM = """\
You are a strict sales conversation evaluator. You're shown a scenario goal,
the customer profile, and a transcript of an agent's attempt. Score the agent
1-5 on whether it did the right thing for the goal:
  5 = nailed it; this is what a great salesperson would do
  4 = good move with minor issues
  3 = fine but generic
  2 = clearly wrong move (pushed when should have backed off, missed a clear
      cue, didn't use available facts, etc.)
  1 = harmful (lied, invented data, ignored explicit no, broke a constraint)

Respond with EXACTLY this JSON shape (no other text, no markdown):
  {"score": <int 1-5>, "reasoning": "<one sentence>"}
"""


async def judge_scenario(client: AsyncOpenAI, scenario: dict, result: ScenarioResult, model: str) -> JudgeResult:
    transcript = []
    for t in result.turns:
        transcript.append(f"CUSTOMER: {t.customer}")
        if t.observations:
            for o in t.observations:
                transcript.append(f"  [observation] {o['name']}({o['args']}) -> {json.dumps(o['result'])[:200]}")
        transcript.append(f"AGENT: {t.agent_text}")
        if t.side_effect_tool:
            transcript.append(f"  [tool] {t.side_effect_tool['name']}({t.side_effect_tool['args']})")

    user_msg = (
        f"SCENARIO GOAL: {scenario['description']}\n"
        f"CUSTOMER PHONE: {scenario['customer_phone']}\n\n"
        "TRANSCRIPT:\n" + "\n".join(transcript)
    )

    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": JUDGE_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        max_tokens=150,
        temperature=0,
        response_format={"type": "json_object"},
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw)
        return JudgeResult(score=int(parsed["score"]), reasoning=parsed["reasoning"])
    except Exception:
        return JudgeResult(score=0, reasoning=f"judge_parse_error: {raw[:100]}")


# ─── Main ─────────────────────────────────────────────────────────────────


def load_scenarios(only: str | None) -> list[dict]:
    scenarios = []
    with open(SCENARIOS_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            s = json.loads(line)
            if only is None or s["id"] == only:
                scenarios.append(s)
    return scenarios


def print_summary(results: list[ScenarioResult]) -> None:
    print()
    print(f"{'ID':<45} {'HEUR':<6} {'JUDGE':<6} {'TOOLS':<8} {'MS':>6}")
    print("-" * 80)
    for r in results:
        heur = "PASS" if r.heuristic_passed else "FAIL"
        judge = f"{r.judge.score}/5" if r.judge and r.judge.score > 0 else " - "
        # count side-effect tool fires
        tool_count = sum(1 for t in r.turns if t.side_effect_tool)
        obs_count = sum(len(t.observations) for t in r.turns)
        tools = f"{tool_count}s/{obs_count}o"
        print(f"{r.id:<45} {heur:<6} {judge:<6} {tools:<8} {r.duration_ms:>6}")
    print("-" * 80)
    n = len(results)
    h_pass = sum(1 for r in results if r.heuristic_passed)
    j_scores = [r.judge.score for r in results if r.judge and r.judge.score > 0]
    j_avg = sum(j_scores) / len(j_scores) if j_scores else 0
    print(f"  heuristics: {h_pass}/{n} pass ({100 * h_pass // max(n, 1)}%)")
    print(f"  judge avg:  {j_avg:.2f}/5 (n={len(j_scores)})")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", help="Run only one scenario by id")
    parser.add_argument("--judge-model", default="gpt-4o-mini")
    parser.add_argument("--no-judge", action="store_true", help="Skip the LLM judge step")
    args = parser.parse_args()

    scenarios = load_scenarios(args.scenario)
    if not scenarios:
        print(f"No scenarios matched '{args.scenario}'", file=sys.stderr)
        return

    db = Prisma()
    await db.connect()
    judge_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

    try:
        results: list[ScenarioResult] = []
        for s in scenarios:
            print(f"  running {s['id']}...", end=" ", flush=True)
            r = await run_scenario(db, s)
            if not args.no_judge and not r.error:
                try:
                    r.judge = await judge_scenario(judge_client, s, r, args.judge_model)
                except Exception as exc:  # noqa: BLE001
                    r.judge = JudgeResult(score=0, reasoning=f"judge_error: {exc}")
            print("done")
            results.append(r)
    finally:
        await db.disconnect()

    RESULTS_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = RESULTS_DIR / f"eval-{timestamp}.json"
    with open(out_path, "w") as f:
        json.dump([asdict(r) for r in results], f, indent=2, default=str)

    print_summary(results)
    print(f"\nFull results: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
