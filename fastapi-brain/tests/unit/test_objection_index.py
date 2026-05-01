"""Unit tests for the Pinecone classifier voting logic.

These tests don't talk to Pinecone — they validate the `vote()` rules in
isolation by constructing fake match lists.
"""

from app.config.settings import settings
from app.services.objection_index import Match, vote


def _m(otype: str, sentiment: str, score: float, subtype: str | None = None) -> Match:
    return Match(
        objection_type=otype,
        sentiment=sentiment,
        subtype=subtype,
        score=score,
        utterance=f"{otype}-{sentiment}-{score}",
    )


def test_vote_returns_none_for_empty_matches():
    assert vote([]) is None


def test_strict_win_when_top1_above_strict_threshold():
    matches = [
        _m("PRICE", "NEGATIVE", 0.92),
        _m("TIMING", "NEGATIVE", 0.55),
        _m("PRICE", "NEUTRAL", 0.50),
    ]
    result = vote(matches)
    assert result is not None
    assert result.objection_type == "PRICE"
    assert result.sentiment == "NEGATIVE"
    assert result.method == "strict"
    assert result.confidence == 0.92


def test_consensus_win_when_top3_agree_above_confidence_threshold():
    matches = [
        _m("PRICE", "NEGATIVE", 0.81),
        _m("PRICE", "NEGATIVE", 0.80),
        _m("PRICE", "NEGATIVE", 0.79),
        _m("TRUST", "NEGATIVE", 0.40),
    ]
    result = vote(matches)
    assert result is not None
    assert result.objection_type == "PRICE"
    assert result.sentiment == "NEGATIVE"
    assert result.method == "consensus"
    assert abs(result.confidence - 0.80) < 1e-6


def test_no_vote_when_top1_below_strict_and_top3_disagree():
    # All scores below strict threshold AND top-3 don't all share a label
    matches = [
        _m("PRICE", "NEGATIVE", 0.82),
        _m("TRUST", "NEGATIVE", 0.80),
        _m("TIMING", "NEUTRAL", 0.79),
    ]
    assert vote(matches) is None


def test_no_vote_when_top3_agree_but_avg_below_confidence_threshold():
    # All three agree but the average is too low to trust
    matches = [
        _m("PRICE", "NEGATIVE", 0.70),
        _m("PRICE", "NEGATIVE", 0.69),
        _m("PRICE", "NEGATIVE", 0.68),
    ]
    assert vote(matches) is None


def test_strict_threshold_boundary_exactly_equal_passes():
    # Boundary check: top1 score == strict threshold should win as strict.
    threshold = settings.classifier_top1_strict_threshold
    matches = [_m("CONFUSION", "NEGATIVE", threshold)]
    result = vote(matches)
    assert result is not None
    assert result.method == "strict"


def test_consensus_threshold_just_above_passes():
    # Use values comfortably above threshold to avoid FP-summation drift —
    # e.g. avg of (0.78, 0.78, 0.78) can land at 0.7799999...
    threshold = settings.classifier_confidence_threshold
    above = threshold + 0.01
    matches = [
        _m("TIMING", "NEGATIVE", above),
        _m("TIMING", "NEGATIVE", above),
        _m("TIMING", "NEGATIVE", above),
    ]
    result = vote(matches)
    assert result is not None
    assert result.method == "consensus"


def test_consensus_just_below_threshold_returns_none():
    threshold = settings.classifier_confidence_threshold
    below = threshold - 0.01
    matches = [
        _m("TIMING", "NEGATIVE", below),
        _m("TIMING", "NEGATIVE", below),
        _m("TIMING", "NEGATIVE", below),
    ]
    assert vote(matches) is None


def test_strict_takes_precedence_when_top3_also_disagree():
    # Even if top-3 disagree, a strong top-1 is still a strict win
    matches = [
        _m("POSITIVE_SIGNAL", "POSITIVE", 0.95),
        _m("NEUTRAL", "NEUTRAL", 0.40),
        _m("CONFUSION", "NEUTRAL", 0.35),
    ]
    result = vote(matches)
    assert result is not None
    assert result.method == "strict"
    assert result.objection_type == "POSITIVE_SIGNAL"


def test_consensus_requires_all_top3_to_agree_not_just_majority():
    # Two of three agree but third differs → no consensus
    matches = [
        _m("PRICE", "NEGATIVE", 0.81),
        _m("PRICE", "NEGATIVE", 0.80),
        _m("TRUST", "NEGATIVE", 0.79),
    ]
    assert vote(matches) is None
