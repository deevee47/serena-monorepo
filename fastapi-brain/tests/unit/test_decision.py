"""Tests for the decision rules engine.

One test per rule, plus priority-ordering tests to ensure earlier branches
short-circuit later ones. Pure-function tests — no mocks, no I/O.
"""

from app.models.requests import ConversationStage, ObjectionType
from app.services.decision import Perception, decide
from app.services.tactics import MICRO_GUIDANCE, Tactic


def _p(**overrides) -> Perception:
    """Build a Perception with sensible defaults; override what each test cares about."""
    defaults = dict(
        objection_type=None,
        objection_subtype=None,
        sentiment=None,
        stage=ConversationStage.PITCH,
        score=50,
        turn_count=3,
        prior_objection_types=[],
        discounts_offered=[],
        has_alternative_product=False,
    )
    defaults.update(overrides)
    return Perception(**defaults)


# ─── Hard exits (priority 1) ─────────────────────────────────────────────────

def test_stage_end_returns_graceful_exit():
    assert decide(_p(stage=ConversationStage.END)).tactic == Tactic.GRACEFUL_EXIT


def test_very_low_score_after_some_turns_returns_graceful_exit():
    d = decide(_p(score=15, turn_count=5, objection_type=ObjectionType.PRICE))
    assert d.tactic == Tactic.GRACEFUL_EXIT


def test_low_score_too_early_does_not_exit():
    # Score < 20 but only 1 turn — give the conversation a chance.
    d = decide(_p(score=15, turn_count=1, stage=ConversationStage.INTRO))
    assert d.tactic != Tactic.GRACEFUL_EXIT


# ─── Buying signals (priority 2) ─────────────────────────────────────────────

def test_ready_to_buy_subtype_returns_assumptive_close():
    d = decide(_p(objection_type=ObjectionType.POSITIVE_SIGNAL, objection_subtype="ready_to_buy"))
    assert d.tactic == Tactic.ASSUMPTIVE_CLOSE


def test_asking_logistics_returns_assumptive_close():
    d = decide(_p(objection_type=ObjectionType.POSITIVE_SIGNAL, objection_subtype="asking_logistics"))
    assert d.tactic == Tactic.ASSUMPTIVE_CLOSE


def test_high_score_positive_signal_returns_trial_close():
    d = decide(_p(objection_type=ObjectionType.POSITIVE_SIGNAL, objection_subtype="agreement", score=72))
    assert d.tactic == Tactic.TRIAL_CLOSE


def test_interested_subtype_at_neutral_score_returns_ask_open():
    d = decide(_p(objection_type=ObjectionType.POSITIVE_SIGNAL, objection_subtype="interested", score=55))
    assert d.tactic == Tactic.ASK_OPEN


def test_close_stage_returns_assumptive_close():
    d = decide(_p(stage=ConversationStage.CLOSE, score=65))
    assert d.tactic == Tactic.ASSUMPTIVE_CLOSE


# ─── Discovery openers (priority 3) ──────────────────────────────────────────

def test_intro_opening_turn_returns_ask_open():
    d = decide(_p(stage=ConversationStage.INTRO, turn_count=0))
    assert d.tactic == Tactic.ASK_OPEN


def test_low_score_early_no_objection_returns_ask_disqualify():
    # The honest disqualification trust-builder.
    d = decide(_p(score=30, turn_count=2, objection_type=None))
    assert d.tactic == Tactic.ASK_DISQUALIFY


# ─── PRICE objection paths (priority 4) ──────────────────────────────────────

def test_first_price_returns_isolate():
    d = decide(_p(objection_type=ObjectionType.PRICE, prior_objection_types=[]))
    assert d.tactic == Tactic.ISOLATE


def test_repeated_price_with_alternative_returns_pivot():
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        objection_subtype="found_cheaper",
        prior_objection_types=[ObjectionType.PRICE],
        has_alternative_product=True,
    ))
    assert d.tactic == Tactic.ALTERNATIVE_PIVOT


def test_repeated_price_budget_subtype_with_alternative_pivots():
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        objection_subtype="budget",
        prior_objection_types=[ObjectionType.PRICE],
        has_alternative_product=True,
    ))
    assert d.tactic == Tactic.ALTERNATIVE_PIVOT


def test_repeated_price_no_alternative_returns_reframe_first_then_concession():
    # Second mention, no concession yet, no alternative → reframe
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        prior_objection_types=[ObjectionType.PRICE],
        discounts_offered=[],
    ))
    assert d.tactic == Tactic.REFRAME


def test_third_price_mention_offers_first_concession():
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        prior_objection_types=[ObjectionType.PRICE, ObjectionType.PRICE],
        discounts_offered=[],
    ))
    assert d.tactic == Tactic.CONCESSION_REAL


def test_after_first_concession_offers_second():
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        prior_objection_types=[ObjectionType.PRICE, ObjectionType.PRICE, ObjectionType.PRICE],
        discounts_offered=[5],
    ))
    assert d.tactic == Tactic.CONCESSION_REAL


def test_max_discount_reached_returns_permission_push():
    # Both concessions given but they're still on PRICE — earn the right to push back.
    d = decide(_p(
        objection_type=ObjectionType.PRICE,
        prior_objection_types=[ObjectionType.PRICE] * 4,
        discounts_offered=[5, 10],
    ))
    assert d.tactic == Tactic.PERMISSION_PUSH


# ─── TRUST objection paths ───────────────────────────────────────────────────

def test_first_trust_returns_ask_open():
    d = decide(_p(objection_type=ObjectionType.TRUST))
    assert d.tactic == Tactic.ASK_OPEN


def test_repeated_trust_returns_non_monetary_concession():
    d = decide(_p(
        objection_type=ObjectionType.TRUST,
        prior_objection_types=[ObjectionType.TRUST],
    ))
    assert d.tactic == Tactic.CONCESSION_NON_MONETARY


# ─── TIMING objection paths ──────────────────────────────────────────────────

def test_wait_for_sale_with_no_concession_offered_yet_returns_concession():
    d = decide(_p(
        objection_type=ObjectionType.TIMING,
        objection_subtype="wait_for_sale",
        discounts_offered=[],
    ))
    assert d.tactic == Tactic.CONCESSION_REAL


def test_first_timing_returns_time_capture():
    d = decide(_p(
        objection_type=ObjectionType.TIMING,
        objection_subtype="not_now",
    ))
    assert d.tactic == Tactic.TIME_CAPTURE


def test_repeated_timing_returns_permission_push():
    d = decide(_p(
        objection_type=ObjectionType.TIMING,
        objection_subtype="not_now",
        prior_objection_types=[ObjectionType.TIMING],
    ))
    assert d.tactic == Tactic.PERMISSION_PUSH


# ─── CONFUSION objection paths ───────────────────────────────────────────────

def test_specific_confusion_subtype_returns_ask_open():
    d = decide(_p(objection_type=ObjectionType.CONFUSION, objection_subtype="how_works"))
    assert d.tactic == Tactic.ASK_OPEN


def test_general_confusion_returns_mirror():
    d = decide(_p(objection_type=ObjectionType.CONFUSION, objection_subtype="feature_unclear"))
    assert d.tactic == Tactic.MIRROR


# ─── Fallback ────────────────────────────────────────────────────────────────

def test_no_signals_falls_back_to_ask_open():
    d = decide(_p(objection_type=ObjectionType.NEUTRAL, score=55, turn_count=4))
    assert d.tactic == Tactic.ASK_OPEN


# ─── Priority ordering ───────────────────────────────────────────────────────

def test_end_stage_overrides_buying_signal():
    # Even with a strong positive signal, an END stage means we exit.
    d = decide(_p(
        stage=ConversationStage.END,
        objection_type=ObjectionType.POSITIVE_SIGNAL,
        objection_subtype="ready_to_buy",
        score=85,
    ))
    assert d.tactic == Tactic.GRACEFUL_EXIT


def test_low_score_exit_overrides_objection_handling():
    # Low score + many turns + a PRICE objection → exit, don't try another concession.
    d = decide(_p(
        score=10,
        turn_count=8,
        objection_type=ObjectionType.PRICE,
        prior_objection_types=[ObjectionType.PRICE] * 3,
    ))
    assert d.tactic == Tactic.GRACEFUL_EXIT


def test_close_stage_overrides_objection_when_not_in_priority_exit():
    # CLOSE stage with a stale objection should still close (after objection-recovery
    # already happened upstream — the FSM should have demoted to NEGOTIATION otherwise).
    d = decide(_p(stage=ConversationStage.CLOSE, objection_type=ObjectionType.PRICE, score=65))
    assert d.tactic == Tactic.ASSUMPTIVE_CLOSE


# ─── Decision payload sanity ─────────────────────────────────────────────────

def test_decision_includes_micro_guidance_matching_chosen_tactic():
    d = decide(_p(objection_type=ObjectionType.PRICE))
    assert d.micro_guidance == MICRO_GUIDANCE[d.tactic]


def test_decision_reasoning_is_non_empty():
    d = decide(_p(objection_type=ObjectionType.TRUST))
    assert d.reasoning and len(d.reasoning) > 5


def test_every_tactic_has_micro_guidance():
    # If we add a new tactic to the enum we must also add a guidance string.
    for t in Tactic:
        assert t in MICRO_GUIDANCE, f"missing micro_guidance for {t}"
        assert MICRO_GUIDANCE[t].strip(), f"empty micro_guidance for {t}"
