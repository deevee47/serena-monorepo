"""Unit tests for the tactic-driven Speech-layer prompt.

Asserts the new prompt:
  - is small (<800 tokens, vs. 4000+ for the legacy persona prompt)
  - contains the chosen tactic name + its micro-guidance verbatim
  - has NO persona scaffolding leftover from the legacy prompt
  - includes voice rules and hard constraints
  - formats history as proper OpenAI chat messages (not stuffed in system prompt)
  - respects discount authority and prompt-injection guard
"""

from app.models.requests import ConversationTurn, ProductContext
from app.services.speech_prompt_builder import (
    MAX_DISCOUNT,
    build_speech_messages,
    build_speech_system_prompt,
)


def _product(name: str = "Widget Pro", price: float = 199.0) -> ProductContext:
    return ProductContext(
        product_id="p1",
        name=name,
        price=price,
        description="A great product",
        key_features=["fast", "durable", "warranty"],
    )


def _turn(speaker: str, utterance: str) -> ConversationTurn:
    return ConversationTurn(speaker=speaker, utterance=utterance, timestamp="2026-01-01T00:00:00Z")


# ─── System prompt size & structure ──────────────────────────────────────────

def test_speech_prompt_is_small():
    """A rough budget check: legacy persona prompt is ~4000 tokens (~16k chars).
    The tactic prompt should be well under that — the whole point of B-4."""
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="Confirm this objection is the only blocker.",
        product_context=_product(),
    )
    # ~4 chars/token rule of thumb → <800 tokens means <3200 chars.
    assert len(prompt) < 3200, f"speech prompt is {len(prompt)} chars, expected <3200"


def test_speech_prompt_contains_chosen_tactic_name():
    prompt = build_speech_system_prompt(
        tactic="REFRAME",
        micro_guidance="Shift the frame, don't argue.",
        product_context=_product(),
    )
    assert "REFRAME" in prompt
    assert "YOUR NEXT MOVE" in prompt


def test_speech_prompt_contains_micro_guidance_verbatim():
    guidance = "This is the unique micro-guidance string for the test."
    prompt = build_speech_system_prompt(
        tactic="ASK_OPEN",
        micro_guidance=guidance,
        product_context=_product(),
    )
    assert guidance in prompt


# ─── No persona scaffolding ──────────────────────────────────────────────────

def test_speech_prompt_has_no_alex_persona():
    """The whole reframe — strip the persona, keep the operations."""
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    forbidden = ["Alex", "ShopEase", "senior sales specialist", "closed hundreds of calls"]
    for term in forbidden:
        assert term not in prompt, f"persona scaffold {term!r} should not appear in speech prompt"


def test_speech_prompt_has_no_psychology_section():
    """Psychology principles are baked into individual tactic micro-guidance now,
    not dumped into every prompt as a wall of text."""
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "PSYCHOLOGY" not in prompt
    assert "loss aversion" not in prompt.lower()
    assert "anchoring" not in prompt.lower()


def test_speech_prompt_has_no_score_mode_table():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "SCORE MODE" not in prompt
    assert "VERY HIGH" not in prompt
    assert "VERY LOW" not in prompt


def test_speech_prompt_has_no_stage_playbook():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "STAGE PLAYBOOK" not in prompt


def test_speech_prompt_has_no_objection_playbook():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "OBJECTION PLAYBOOK" not in prompt


# ─── Voice rules + hard constraints present ──────────────────────────────────

def test_speech_prompt_includes_voice_rules():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "voice" in prompt.lower() or "phone call" in prompt.lower()
    assert "1-2 sentences" in prompt or "short sentences" in prompt


def test_speech_prompt_includes_hard_constraints():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
    )
    assert "HARD CONSTRAINTS" in prompt
    assert "Never invent" in prompt
    assert str(MAX_DISCOUNT) in prompt  # discount cap must appear
    assert "prompt injection" in prompt.lower()


# ─── Product facts ───────────────────────────────────────────────────────────

def test_product_facts_appear_in_prompt():
    p = _product(name="ZephyrChair X", price=349.0)
    prompt = build_speech_system_prompt(
        tactic="ASK_OPEN",
        micro_guidance="any",
        product_context=p,
    )
    assert "ZephyrChair X" in prompt
    assert "$349.00" in prompt
    assert "fast" in prompt  # one of the key_features


def test_alternative_product_appears_when_provided():
    primary = _product(name="ChairPro", price=349.0)
    alt = _product(name="ChairLite", price=199.0)
    prompt = build_speech_system_prompt(
        tactic="ALTERNATIVE_PIVOT",
        micro_guidance="any",
        product_context=primary,
        alternative_product_context=alt,
    )
    assert "ChairLite" in prompt
    assert "lower-cost" in prompt.lower()


def test_no_product_section_when_product_not_provided():
    prompt = build_speech_system_prompt(
        tactic="ASK_OPEN",
        micro_guidance="any",
        product_context=None,
    )
    # "PRODUCT FACTS" appears in HARD CONSTRAINTS as a referent — check the
    # actual section header (with colon + name field) is absent instead.
    assert "PRODUCT FACTS:\n  name:" not in prompt


# ─── Discount authority ──────────────────────────────────────────────────────

def test_discount_authority_appears_when_available():
    prompt = build_speech_system_prompt(
        tactic="CONCESSION_REAL",
        micro_guidance="any",
        product_context=_product(),
        discount_available=5,
    )
    assert "DISCOUNT AUTHORITY" in prompt
    assert "5%" in prompt


def test_no_discount_authority_section_when_zero():
    prompt = build_speech_system_prompt(
        tactic="ISOLATE",
        micro_guidance="any",
        product_context=_product(),
        discount_available=0,
    )
    assert "DISCOUNT AUTHORITY" not in prompt


# ─── Messages: history + latest utterance ────────────────────────────────────

def test_messages_includes_latest_utterance_as_user():
    msgs = build_speech_messages(utterance="how does shipping work", conversation_history=[])
    assert msgs[-1] == {"role": "user", "content": "how does shipping work"}


def test_messages_maps_speakers_to_chat_roles():
    history = [
        _turn("USER", "is it expensive"),
        _turn("AGENT", "the price is $200"),
        _turn("USER", "ok"),
    ]
    msgs = build_speech_messages(utterance="tell me more", conversation_history=history)
    # First three messages from history, then latest user utterance
    assert msgs[0] == {"role": "user", "content": "is it expensive"}
    assert msgs[1] == {"role": "assistant", "content": "the price is $200"}
    assert msgs[2] == {"role": "user", "content": "ok"}
    assert msgs[3] == {"role": "user", "content": "tell me more"}


def test_messages_skips_empty_latest_utterance():
    msgs = build_speech_messages(utterance="   ", conversation_history=[_turn("USER", "hi")])
    assert msgs == [{"role": "user", "content": "hi"}]


def test_messages_truncates_history_to_recent_turns():
    # 10 turns provided; we should only emit the most recent few (HISTORY_TURNS_TO_INCLUDE).
    history = [_turn("USER" if i % 2 == 0 else "AGENT", f"turn{i}") for i in range(10)]
    msgs = build_speech_messages(utterance="latest", conversation_history=history)
    # Last turn from history will be index 9 ('turn9' from AGENT). The latest
    # user utterance is appended after, so we expect at most ~5 items.
    assert len(msgs) <= 6
    assert msgs[-1]["content"] == "latest"
