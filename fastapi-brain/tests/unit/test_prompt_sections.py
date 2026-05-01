"""Tests for the shared prompt-section helpers."""

from app.models.requests import CartContext, CartItem, ConversationTurn, ProductContext
from app.services.prompt_sections import (
    HISTORY_TURNS_TO_INCLUDE,
    MAX_DISCOUNT,
    build_chat_messages,
    format_cart,
    format_product,
)


def _turn(speaker: str, utterance: str) -> ConversationTurn:
    return ConversationTurn(speaker=speaker, utterance=utterance, timestamp="2026-01-01T00:00:00Z")


# ─── format_product ──────────────────────────────────────────────────────

def test_format_product_returns_empty_when_none():
    assert format_product("PRODUCT FACTS", None) == ""


def test_format_product_includes_label_name_price_features():
    p = ProductContext(
        product_id="p1",
        name="ZephyrChair Pro",
        price=349.0,
        description="An ergonomic office chair",
        key_features=["3D lumbar", "5-year warranty"],
    )
    out = format_product("PRODUCT FACTS", p)
    assert "PRODUCT FACTS:" in out
    assert "ZephyrChair Pro" in out
    assert "$349.00" in out
    assert "3D lumbar" in out
    assert "5-year warranty" in out


# ─── format_cart ─────────────────────────────────────────────────────────

def test_format_cart_returns_empty_when_none():
    assert format_cart(None) == ""


def test_format_cart_returns_empty_when_no_items():
    assert format_cart(CartContext(items=[], total=0.0)) == ""


def test_format_cart_includes_total_and_quantity():
    cart = CartContext(
        items=[
            CartItem(product_id="x", name="Widget", price=49.0, quantity=2),
        ],
        total=98.0,
        abandoned_minutes_ago=10,
    )
    out = format_cart(cart)
    assert "2× Widget" in out
    assert "$49.00" in out
    assert "$98.00" in out
    assert "abandoned ~10 min ago" in out


def test_format_cart_omits_quantity_when_one():
    cart = CartContext(
        items=[CartItem(product_id="x", name="Widget", price=49.0)],
        total=49.0,
    )
    out = format_cart(cart)
    assert "1× Widget" not in out
    assert "Widget" in out


# ─── build_chat_messages ─────────────────────────────────────────────────

def test_build_chat_messages_empty_history_only_includes_latest():
    msgs = build_chat_messages(utterance="hi", conversation_history=[])
    assert msgs == [{"role": "user", "content": "hi"}]


def test_build_chat_messages_maps_speaker_to_role():
    history = [
        _turn("USER", "first question"),
        _turn("AGENT", "first reply"),
    ]
    msgs = build_chat_messages(utterance="follow up", conversation_history=history)
    assert msgs[0] == {"role": "user", "content": "first question"}
    assert msgs[1] == {"role": "assistant", "content": "first reply"}
    assert msgs[2] == {"role": "user", "content": "follow up"}


def test_build_chat_messages_truncates_history():
    history = [_turn("USER" if i % 2 == 0 else "AGENT", f"turn {i}") for i in range(10)]
    msgs = build_chat_messages(utterance="latest", conversation_history=history)
    # At most HISTORY_TURNS_TO_INCLUDE from history + 1 latest
    assert len(msgs) <= HISTORY_TURNS_TO_INCLUDE + 1
    assert msgs[-1] == {"role": "user", "content": "latest"}


def test_build_chat_messages_skips_empty_utterance():
    msgs = build_chat_messages(utterance="   ", conversation_history=[_turn("USER", "earlier")])
    assert msgs == [{"role": "user", "content": "earlier"}]


# ─── Constants exported ──────────────────────────────────────────────────

def test_max_discount_is_ten():
    assert MAX_DISCOUNT == 10
