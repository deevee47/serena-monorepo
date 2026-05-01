"""Voice-channel signal derivation.

Pure functions that turn recent user utterances into engagement signals the
Decision layer can react to. Inputs are plain strings — no I/O, no LLM, fully
testable. Inputs come from node-gateway (which has the full session history),
shaped into a small `SignalSnapshot` to keep the wire payload small.

Signals derived:
  - utterance_length_trend: slope of token-count across recent user utterances.
                            Positive = engaging more, negative = disengaging.
  - filler_density:         ratio of filler words (uh, um, like, i guess, ...)
                            to total tokens across recent user utterances.
                            High = uncertainty / hesitation.
  - response_latency_ms:    most recent USER reply's pre-response latency
                            (time between agent finishing speaking and user
                            starting to reply). High = considering, very low
                            = strong reaction.
"""

from dataclasses import dataclass

FILLER_TOKENS = {"uh", "um", "uhh", "ehh", "like", "i", "guess"}
FILLER_PHRASES = ("i guess", "you know", "kind of", "sort of", "i mean")


@dataclass(frozen=True)
class SignalSnapshot:
    """Small snapshot of voice-channel signals for the current turn. All
    fields are optional — node-gateway populates what it can derive."""

    utterance_length_trend: float | None = None  # tokens-per-turn slope, recent N turns
    filler_density: float | None = None  # 0.0 – 1.0
    response_latency_ms: int | None = None  # most recent user reply latency


def utterance_length_trend(recent_user_utterances: list[str]) -> float | None:
    """Slope of token-count across recent USER utterances.

    Returns None if fewer than 2 utterances. Positive = lengths growing
    (engaging more); negative = shrinking (disengaging).
    """
    if len(recent_user_utterances) < 2:
        return None
    lengths = [len(u.split()) for u in recent_user_utterances]
    n = len(lengths)
    # Simple linear regression slope: cov(x, y) / var(x)
    mean_x = (n - 1) / 2
    mean_y = sum(lengths) / n
    cov = sum((i - mean_x) * (lengths[i] - mean_y) for i in range(n))
    var = sum((i - mean_x) ** 2 for i in range(n))
    if var == 0:
        return 0.0
    return cov / var


def filler_density(recent_user_utterances: list[str]) -> float | None:
    """Ratio of filler tokens to total tokens across recent USER utterances.

    Returns None if no utterances. 0.0 means no fillers; values >0.15 are
    typically interpreted as hesitation/uncertainty.
    """
    if not recent_user_utterances:
        return None
    total_tokens = 0
    filler_count = 0
    for u in recent_user_utterances:
        text = u.lower()
        # phrases first (so "i guess" counts once, not as "i" + "guess")
        for phrase in FILLER_PHRASES:
            occurrences = text.count(phrase)
            filler_count += occurrences
            # remove counted phrases so the per-token loop doesn't double-count
            text = text.replace(phrase, " ")
        tokens = [t.strip(".,!?;:") for t in text.split()]
        total_tokens += len(tokens) + sum(text.count(p) for p in FILLER_PHRASES)
        for tok in tokens:
            if tok in FILLER_TOKENS:
                filler_count += 1
    if total_tokens == 0:
        return 0.0
    return min(1.0, filler_count / total_tokens)
