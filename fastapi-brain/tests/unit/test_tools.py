"""Tests for the tool schema + parser used by /converse."""

import pytest

from app.services.tools import (
    MAX_DISCOUNT_PERCENT,
    OPENAI_TOOLS,
    SendCheckoutLinkArgs,
    ValidationError,
    parse_tool_call,
)


def test_openai_tools_exposes_side_effect_and_observation_tools():
    names = {t["function"]["name"] for t in OPENAI_TOOLS}
    # Side-effect tools (gateway dispatches)
    assert "send_whatsapp_checkout_link" in names
    assert "send_whatsapp_product_info" in names
    # Observation tools (server-side, result fed back to LLM)
    assert "check_inventory" in names
    assert "get_recent_purchases" in names
    assert "get_review_summary" in names
    assert "get_delivery_eta" in names
    assert all(t["type"] == "function" for t in OPENAI_TOOLS)


def test_checkout_link_args_accepts_zero_discount():
    args = SendCheckoutLinkArgs(discount_percent=0)
    assert args.discount_percent == 0


def test_checkout_link_args_accepts_max_discount():
    args = SendCheckoutLinkArgs(discount_percent=MAX_DISCOUNT_PERCENT)
    assert args.discount_percent == MAX_DISCOUNT_PERCENT


def test_checkout_link_args_rejects_above_max():
    with pytest.raises(ValidationError):
        SendCheckoutLinkArgs(discount_percent=MAX_DISCOUNT_PERCENT + 1)


def test_checkout_link_args_rejects_negative():
    with pytest.raises(ValidationError):
        SendCheckoutLinkArgs(discount_percent=-5)


def test_checkout_link_args_default_is_zero():
    args = SendCheckoutLinkArgs()
    assert args.discount_percent == 0


def test_parse_tool_call_valid_checkout():
    parsed = parse_tool_call("send_whatsapp_checkout_link", {"discount_percent": 5})
    assert parsed.name == "send_whatsapp_checkout_link"
    assert parsed.args == {"discount_percent": 5}


def test_parse_tool_call_valid_product_info_with_no_args():
    parsed = parse_tool_call("send_whatsapp_product_info", {})
    assert parsed.name == "send_whatsapp_product_info"
    assert parsed.args == {}


def test_parse_tool_call_unknown_tool_raises_value_error():
    with pytest.raises(ValueError, match="unknown tool name"):
        parse_tool_call("send_telegram_message", {"text": "hi"})


def test_parse_tool_call_invalid_args_raises_validation_error():
    with pytest.raises(ValidationError):
        parse_tool_call("send_whatsapp_checkout_link", {"discount_percent": 25})
