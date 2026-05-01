from app.models.requests import GenerateResponseRequest
from app.services.prompt_builder import build_system_prompt, _analyze_history, ConversationTurn


def _turn(speaker: str, utterance: str) -> dict:
    return {"speaker": speaker, "utterance": utterance, "timestamp": "2026-01-01T00:00:00Z"}


def _base_req(**overrides) -> GenerateResponseRequest:
    defaults = dict(
        call_id="c-test",
        utterance="Hello",
        stage="PITCH",
        score=50,
        discount_available=0,
        objection_type=None,
        conversation_history=[],
        product_context=None,
        alternative_product_context=None,
    )
    defaults.update(overrides)
    return GenerateResponseRequest(**defaults)


def _product(name="Widget Pro", price=199.0):
    return {
        "product_id": "p1",
        "name": name,
        "price": price,
        "description": "A great product",
        "key_features": ["fast", "durable", "easy to use", "lightweight", "portable"],
    }


# ── History analysis ──────────────────────────────────────────────────────────

def test_analyze_history_detects_price_mentions():
    history = [
        ConversationTurn(**_turn("USER", "That's too expensive for me")),
        ConversationTurn(**_turn("AGENT", "I hear you")),
        ConversationTurn(**_turn("USER", "The cost is really high")),
    ]
    result = _analyze_history(history)
    assert result["price_mentions"] == 2


def test_analyze_history_detects_positive_signals():
    history = [
        ConversationTurn(**_turn("USER", "That sounds great, I love it")),
        ConversationTurn(**_turn("AGENT", "Glad to hear it")),
        ConversationTurn(**_turn("USER", "Sounds perfect, let's do it")),
    ]
    result = _analyze_history(history)
    assert result["positive_signals"] == 2


def test_analyze_history_detects_stuck_loop():
    history = [
        ConversationTurn(**_turn("USER", "It's too expensive")),
        ConversationTurn(**_turn("AGENT", "Here's the value...")),
        ConversationTurn(**_turn("USER", "Still too expensive, let me think")),
        ConversationTurn(**_turn("AGENT", "I understand")),
        ConversationTurn(**_turn("USER", "Yeah I'm not sure, not right now")),
    ]
    result = _analyze_history(history)
    assert result["stuck_in_loop"] is True


def test_analyze_history_exchange_count():
    history = [
        ConversationTurn(**_turn("USER", "Hi")),
        ConversationTurn(**_turn("AGENT", "Hello")),
        ConversationTurn(**_turn("USER", "Tell me more")),
        ConversationTurn(**_turn("AGENT", "Sure")),
    ]
    result = _analyze_history(history)
    assert result["exchange_count"] == 2


# ── Prompt content ────────────────────────────────────────────────────────────

def test_stuck_loop_warning_injected():
    history = [
        ConversationTurn(**_turn("USER", "It's expensive")),
        ConversationTurn(**_turn("AGENT", "Here's the value...")),
        ConversationTurn(**_turn("USER", "Still expensive, not right now")),
        ConversationTurn(**_turn("AGENT", "I understand")),
        ConversationTurn(**_turn("USER", "I'm not sure about the cost")),
    ]
    req = _base_req(
        stage="NEGOTIATION",
        objection_type="PRICE",
        score=30,
        conversation_history=[t.model_dump() for t in history],
    )
    prompt = build_system_prompt(req)
    assert "STUCK LOOP" in prompt


def test_positive_signal_warning_injected():
    history = [
        ConversationTurn(**_turn("USER", "Sounds great, I love it")),
        ConversationTurn(**_turn("AGENT", "Great")),
        ConversationTurn(**_turn("USER", "Yes that's perfect exactly")),
    ]
    req = _base_req(
        score=75,
        conversation_history=[t.model_dump() for t in history],
    )
    prompt = build_system_prompt(req)
    assert "positive signals" in prompt.lower()


def test_alternative_product_in_prompt():
    req = _base_req(
        stage="NEGOTIATION",
        score=35,
        discount_available=5,
        objection_type="PRICE",
        product_context=_product("ProComfort Chair", 349.0),
        alternative_product_context={
            "product_id": "prod-002",
            "name": "ProComfort Lite Chair",
            "price": 179.0,
            "description": "Affordable ergonomic chair",
            "key_features": ["ergonomic", "adjustable", "home office"],
        },
    )
    prompt = build_system_prompt(req)
    assert "ProComfort Chair" in prompt
    assert "ProComfort Lite Chair" in prompt
    assert "lower price point" in prompt


def test_discount_last_resort_framing():
    req = _base_req(discount_available=8, product_context=_product())
    prompt = build_system_prompt(req)
    assert "8%" in prompt
    assert "last resort" in prompt.lower()


def test_no_discount_holds_value_frame():
    req = _base_req(discount_available=0)
    prompt = build_system_prompt(req)
    assert "None available" in prompt


def test_very_high_score_mode():
    req = _base_req(score=85)
    prompt = build_system_prompt(req)
    assert "VERY HIGH" in prompt


def test_very_low_score_mode():
    req = _base_req(score=10)
    prompt = build_system_prompt(req)
    assert "VERY LOW" in prompt


def test_price_objection_playbook_injected():
    req = _base_req(stage="OBJECTION", objection_type="PRICE")
    prompt = build_system_prompt(req)
    assert "PRICE" in prompt
    assert "ISOLATE" in prompt
    assert "lower-cost" in prompt.lower() or "lower price point" in prompt.lower()


def test_trust_objection_includes_risk_reversal():
    req = _base_req(stage="OBJECTION", objection_type="TRUST")
    prompt = build_system_prompt(req)
    assert "TRUST" in prompt
    assert "RISK REVERSAL" in prompt


def test_timing_objection_no_fake_urgency():
    req = _base_req(stage="OBJECTION", objection_type="TIMING")
    prompt = build_system_prompt(req)
    assert "fake urgency" in prompt.lower() or "never invent" in prompt.lower()


def test_positive_signal_objection_includes_close():
    req = _base_req(stage="CLOSE", objection_type="POSITIVE_SIGNAL")
    prompt = build_system_prompt(req)
    assert "STOP" in prompt or "stop" in prompt.lower()


def test_no_objection_section_when_none():
    req = _base_req(objection_type=None)
    prompt = build_system_prompt(req)
    assert "ACTIVE OBJECTION" not in prompt


def test_stage_tactic_injected():
    req = _base_req(stage="CLOSE")
    prompt = build_system_prompt(req)
    assert "CLOSE" in prompt


def test_product_features_in_prompt():
    req = _base_req(product_context=_product("SuperWidget", 99.0))
    prompt = build_system_prompt(req)
    assert "SuperWidget" in prompt
    assert "$99.00" in prompt


def test_anti_patterns_section_present():
    req = _base_req()
    prompt = build_system_prompt(req)
    assert "ANTI-PATTERNS" in prompt
    assert "apologise for the price" in prompt.lower()


def test_prompt_injection_guard_present():
    req = _base_req()
    prompt = build_system_prompt(req)
    assert "[CUSTOMER]" in prompt
    assert "prompt injection" in prompt.lower()


def test_psychology_section_present():
    req = _base_req()
    prompt = build_system_prompt(req)
    assert "LOSS AVERSION" in prompt
    assert "ANCHORING" in prompt
    assert "ISOLATION" in prompt
    assert "FEEL-FELT-FOUND" in prompt
