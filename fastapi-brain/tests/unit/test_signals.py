"""Tests for the voice-channel signal derivation helpers."""

from app.services.signals import filler_density, utterance_length_trend


# ─── utterance_length_trend ──────────────────────────────────────────────────

def test_length_trend_returns_none_for_empty():
    assert utterance_length_trend([]) is None


def test_length_trend_returns_none_for_single_utterance():
    # Slope undefined with one point
    assert utterance_length_trend(["hello there friend"]) is None


def test_length_trend_zero_when_lengths_constant():
    assert utterance_length_trend(["a b c", "d e f", "g h i"]) == 0.0


def test_length_trend_positive_when_growing():
    # Lengths 1, 2, 3 → slope 1.0
    slope = utterance_length_trend(["one", "one two", "one two three"])
    assert slope is not None and slope == 1.0


def test_length_trend_negative_when_shrinking():
    # Lengths 5, 3, 1 → slope -2.0
    slope = utterance_length_trend([
        "this is the first utterance",
        "shorter reply now",
        "yes",
    ])
    assert slope is not None and slope == -2.0


def test_length_trend_handles_punctuation_as_part_of_word():
    # "yes." counts as one token via split() — that's fine, we just want slope direction.
    slope = utterance_length_trend(["a b c d", "yes.", "no"])
    assert slope is not None and slope < 0


# ─── filler_density ──────────────────────────────────────────────────────────

def test_filler_density_returns_none_for_no_utterances():
    assert filler_density([]) is None


def test_filler_density_zero_when_no_fillers():
    assert filler_density(["the price is too high for me"]) == 0.0


def test_filler_density_counts_uh_um_like():
    # 3 fillers in 6 tokens → 0.5
    d = filler_density(["uh um like yeah okay then"])
    assert d is not None and d > 0.4


def test_filler_density_counts_phrases():
    # "i guess" is a single phrase token
    d = filler_density(["yeah i guess that works for me"])
    assert d is not None and d > 0


def test_filler_density_capped_at_one():
    d = filler_density(["uh uh uh"])
    assert d is not None and 0.0 < d <= 1.0


def test_filler_density_aggregates_across_utterances():
    d = filler_density(["the price is fair", "uh i mean it's a lot"])
    assert d is not None and d > 0
