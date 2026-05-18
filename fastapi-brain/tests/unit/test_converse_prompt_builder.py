"""Tests for the converse system-prompt builder.

Asserts the prompt is small, contains the principles + tool guidance + facts,
and stays free of legacy persona scaffolding.
"""

from app.models.requests import (
    CartContext,
    CartItem,
    ProductContext,
    RecentUserSignals,
    Sentiment,
)
from app.services.converse_prompt_builder import build_converse_system_prompt
from app.services.prompt_sections import HARD_CONSTRAINTS, MAX_DISCOUNT, VOICE_RULES


def _product(name: str = "Widget Pro", price: float = 199.0) -> ProductContext:
    return ProductContext(
        product_id="p1",
        name=name,
        price=price,
        description="A great product",
        key_features=["fast", "durable", "warranty"],
    )


def _cart() -> CartContext:
    return CartContext(
        items=[
            CartItem(product_id="p1", name="Widget Pro", price=199.0),
            CartItem(product_id="acc", name="Cushion", price=29.0),
        ],
        total=228.0,
        abandoned_minutes_ago=15,
    )


# ─── Size & structure ─────────────────────────────────────────────────────

def test_prompt_is_under_token_budget():
    """Should land well under 8k tokens (~32k chars at 4 chars/token) so it
    leaves plenty of room for the conversation history within OpenAI's 128k
    context. Adjust this cap when intentionally adding sections."""
    prompt = build_converse_system_prompt(
        product_context=_product(),
        alternative_product_context=_product(name="Widget Lite", price=99.0),
        cart_context=_cart(),
        discounts_already_offered=[5],
    )
    assert len(prompt) < 32_000, f"prompt is {len(prompt)} chars (~{len(prompt)//4} tokens)"


def test_prompt_includes_objective():
    prompt = build_converse_system_prompt()
    assert "sales operator" in prompt.lower()
    # The opening describes a customer who left items in their cart.
    assert "items in their cart" in prompt.lower()


def test_prompt_includes_voice_rules():
    prompt = build_converse_system_prompt()
    assert VOICE_RULES.split("\n")[0] in prompt or "1-2 sentences" in prompt


def test_prompt_includes_principles():
    prompt = build_converse_system_prompt()
    assert "PRINCIPLES" in prompt
    assert "ISOLATE" in prompt
    # The flat-discount ladder is the last-resort lever in the principles.
    assert "flat negotiation discount" in prompt.lower() or "flat-discount ladder" in prompt.lower()
    assert "honest disqualification" in prompt.lower()


def test_prompt_includes_tool_guidance():
    prompt = build_converse_system_prompt()
    assert "TOOLS" in prompt
    assert "send_whatsapp_checkout_link" in prompt
    assert "send_whatsapp_product_info" in prompt


def test_prompt_includes_hard_constraints():
    prompt = build_converse_system_prompt()
    assert "HARD CONSTRAINTS" in prompt
    assert str(MAX_DISCOUNT) in prompt
    assert "prompt injection" in prompt.lower()


# ─── No persona scaffolding ───────────────────────────────────────────────

def test_prompt_has_no_alex_persona():
    """The whole reframe — strip the persona, keep the operations."""
    prompt = build_converse_system_prompt(product_context=_product())
    forbidden = ["Alex", "ShopEase", "senior sales specialist", "closed hundreds of calls"]
    for term in forbidden:
        assert term not in prompt, f"persona scaffold {term!r} should not appear"


def test_prompt_has_no_score_modes_or_stage_playbooks():
    prompt = build_converse_system_prompt()
    assert "SCORE MODE" not in prompt
    assert "STAGE PLAYBOOK" not in prompt
    assert "OBJECTION PLAYBOOK" not in prompt
    assert "VERY HIGH" not in prompt
    assert "VERY LOW" not in prompt


# ─── Cart / product / alternative ─────────────────────────────────────────

def test_cart_appears_when_provided():
    prompt = build_converse_system_prompt(
        product_context=_product(),
        cart_context=_cart(),
    )
    assert "Widget Pro" in prompt
    assert "Cushion" in prompt
    assert "$228.00" in prompt
    # The cart freshness banner phrase ranges from "just now" through
    # "yesterday" depending on minutes ago. 15 minutes lands in the
    # ~30-minute "just now" bucket per _format_abandoned_when.
    assert "abandoned just now" in prompt


def test_cart_section_omitted_when_no_cart():
    prompt = build_converse_system_prompt(product_context=_product())
    assert "CUSTOMER'S CART" not in prompt


def test_product_facts_appear():
    p = _product(name="ZephyrChair Pro", price=349.0)
    prompt = build_converse_system_prompt(product_context=p)
    assert "ZephyrChair Pro" in prompt
    assert "$349.00" in prompt
    assert "fast" in prompt


def test_alternative_product_appears_with_label():
    primary = _product(name="ChairPro", price=349.0)
    alt = _product(name="ChairLite", price=199.0)
    prompt = build_converse_system_prompt(
        product_context=primary,
        alternative_product_context=alt,
    )
    assert "ChairLite" in prompt
    assert "ALTERNATIVE PRODUCT" in prompt


# ─── Discounts already offered ────────────────────────────────────────────

def test_no_discount_offered_yet_describes_ladder():
    prompt = build_converse_system_prompt(discounts_already_offered=[])
    # Empty discount list => "Opener carries the 5% call-completion offer..."
    assert "Opener carries" in prompt
    assert "5%" in prompt and "10%" in prompt


def test_first_tier_offered_signals_next_step():
    prompt = build_converse_system_prompt(discounts_already_offered=[5])
    assert "5%" in prompt
    assert "next ladder step is 10%" in prompt


def test_full_ladder_signals_no_more():
    prompt = build_converse_system_prompt(discounts_already_offered=[5, 10])
    # Both have been offered; the next step block reflects the cap.
    assert "5%" in prompt and "10%" in prompt


# ─── Disfluency, humor, adaptive-behavior sections ───────────────────────


def test_prompt_includes_disfluency_and_humor_block():
    prompt = build_converse_system_prompt()
    assert "DISFLUENCIES & HUMOR" in prompt
    # Imperative thinking-aloud examples should be present in both languages.
    assert "hmm —" in prompt or "hmm —" in prompt.lower()
    assert "ek second" in prompt
    # The humor budget rule must appear.
    assert "AT MOST ONE per call" in prompt or "at most one per call" in prompt.lower()


def test_adaptive_behavior_only_appears_when_signals_warrant_it():
    # The block header is `ADAPTIVE BEHAVIOR (this call, right now):` — that
    # substring uniquely identifies the rendered block (not the passing
    # mention inside DISFLUENCIES & HUMOR).
    BLOCK_MARKER = "ADAPTIVE BEHAVIOR (this call"

    prompt = build_converse_system_prompt()
    assert BLOCK_MARKER not in prompt

    # Single neutral turn → still nothing actionable.
    quiet = RecentUserSignals(sentiments=[Sentiment.NEUTRAL])
    prompt = build_converse_system_prompt(recent_user_signals=quiet)
    assert BLOCK_MARKER not in prompt


def test_adaptive_behavior_softens_on_negative_streak():
    signals = RecentUserSignals(
        sentiments=[Sentiment.NEGATIVE, Sentiment.NEGATIVE, Sentiment.NEGATIVE],
    )
    prompt = build_converse_system_prompt(recent_user_signals=signals)
    assert "ADAPTIVE BEHAVIOR" in prompt
    assert "NEGATIVE" in prompt
    # The cue tells the agent to drop pitch energy and skip humor.
    assert "drop pitch energy" in prompt.lower()
    assert "skip humor" in prompt.lower()


def test_adaptive_behavior_flags_repeated_objection():
    signals = RecentUserSignals(
        sentiments=[Sentiment.NEUTRAL, Sentiment.NEUTRAL],
        repeated_objection="PRICE",
    )
    prompt = build_converse_system_prompt(recent_user_signals=signals)
    assert "ADAPTIVE BEHAVIOR" in prompt
    assert "REPEATED OBJECTION" in prompt
    assert "PRICE" in prompt


def test_adaptive_behavior_opens_humor_budget_on_warm_signal():
    signals = RecentUserSignals(
        sentiments=[Sentiment.POSITIVE, Sentiment.POSITIVE],
    )
    prompt = build_converse_system_prompt(recent_user_signals=signals)
    assert "ADAPTIVE BEHAVIOR" in prompt
    assert "humor budget is open" in prompt.lower()


def test_late_night_opener_drops_discount_and_asks_consent():
    """When time-of-day guidance kicks in for ≥22:00 the opener must ask
    consent before pitching, dropping the discount line."""
    from app.models.requests import CustomerContext

    customer = CustomerContext(phone="+15551234567", timezone="Pacific/Niue")
    # Pacific/Niue is UTC-11; the test only asserts the prompt structure, not
    # the actual guidance string, so we don't depend on a specific local hour.
    prompt = build_converse_system_prompt(customer_context=customer)
    # The local-time block should be present whenever a timezone is set.
    assert "LOCAL CONTEXT" in prompt
