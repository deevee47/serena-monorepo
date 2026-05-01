"""Tests for the converse system-prompt builder.

Asserts the prompt is small, contains the principles + tool guidance + facts,
and stays free of legacy persona scaffolding.
"""

from app.models.requests import CartContext, CartItem, ProductContext
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
    """Should land roughly under 1500 tokens (~6000 chars at 4 chars/token).
    Concrete cap: well under 6500 chars even with all sections present."""
    prompt = build_converse_system_prompt(
        product_context=_product(),
        alternative_product_context=_product(name="Widget Lite", price=99.0),
        cart_context=_cart(),
        discounts_already_offered=[5],
    )
    assert len(prompt) < 6500, f"prompt is {len(prompt)} chars (~{len(prompt)//4} tokens)"


def test_prompt_includes_objective():
    prompt = build_converse_system_prompt()
    assert "sales operator" in prompt.lower()
    assert "abandoned cart" in prompt.lower()


def test_prompt_includes_voice_rules():
    prompt = build_converse_system_prompt()
    assert VOICE_RULES.split("\n")[0] in prompt or "1-2 sentences" in prompt


def test_prompt_includes_principles():
    prompt = build_converse_system_prompt()
    assert "PRINCIPLES" in prompt
    assert "ISOLATE" in prompt
    assert "concession ladder" in prompt.lower()
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
    assert "abandoned ~15 min" in prompt


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
    assert "DISCOUNTS ALREADY OFFERED THIS CALL: none" in prompt
    assert "5% first push" in prompt


def test_first_tier_offered_signals_next_step():
    prompt = build_converse_system_prompt(discounts_already_offered=[5])
    assert "5%" in prompt
    assert "next ladder step is 10%" in prompt


def test_full_ladder_signals_no_more():
    prompt = build_converse_system_prompt(discounts_already_offered=[5, 10])
    # Both have been offered; the next step block reflects the cap.
    assert "5%" in prompt and "10%" in prompt
