"""Decision layer — given a Perception of the customer, pick the next tactic.

Pure function. No I/O. No LLM. Inspectable, deterministic, A/B-able.

Rules are applied in priority order:
  1. Hard exits (END / very low score / failed pursuit)
  2. Strong buying signals (close-side)
  3. Stage-driven openers (INTRO / PITCH first turns)
  4. Objection-specific paths (PRICE / TRUST / TIMING / CONFUSION)
  5. Fallback (ASK_OPEN — when in doubt, deepen understanding)

The first rule that matches wins. Each branch returns a Decision with a
one-sentence `reasoning` for log attribution.
"""

from dataclasses import dataclass

from app.models.requests import ConversationStage, ObjectionType
from app.services.tactics import Decision, Tactic, micro_guidance


@dataclass(frozen=True)
class Perception:
    """Everything the rules engine needs to pick a tactic.

    Built from the live session in node-gateway plus the per-utterance
    classifier output. All fields are required — keep this dumb and explicit
    rather than carrying a giant request object that drags context.
    """
    objection_type: ObjectionType | None
    objection_subtype: str | None
    sentiment: str | None  # 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
    stage: ConversationStage
    score: int
    turn_count: int
    prior_objection_types: list[ObjectionType]
    discounts_offered: list[int]  # e.g. [] | [5] | [5, 10]
    has_alternative_product: bool


# Score thresholds — duplicated as named constants so changes are searchable.
SCORE_GRACEFUL_EXIT = 20
SCORE_TRIAL_CLOSE = 70
SCORE_ASSUMPTIVE_CLOSE = 80


def decide(p: Perception) -> Decision:
    # 1. Hard exits ---------------------------------------------------------
    if p.stage == ConversationStage.END:
        return _decision(Tactic.GRACEFUL_EXIT, "stage is END — already exiting")

    if p.score < SCORE_GRACEFUL_EXIT and p.turn_count >= 3:
        return _decision(
            Tactic.GRACEFUL_EXIT,
            f"score {p.score} below {SCORE_GRACEFUL_EXIT} after {p.turn_count} turns — preserve relationship over forcing close",
        )

    # 2. Buying signals (close-side) ----------------------------------------
    if p.objection_type == ObjectionType.POSITIVE_SIGNAL:
        if p.objection_subtype in {"ready_to_buy", "asking_logistics"} or p.score >= SCORE_ASSUMPTIVE_CLOSE:
            return _decision(
                Tactic.ASSUMPTIVE_CLOSE,
                f"explicit buying signal (subtype={p.objection_subtype}, score={p.score})",
            )
        if p.score >= SCORE_TRIAL_CLOSE:
            return _decision(
                Tactic.TRIAL_CLOSE,
                f"strong positive signal at score {p.score} — soft commitment test",
            )
        if p.objection_subtype == "interested":
            return _decision(Tactic.ASK_OPEN, "interested but not committed — deepen the interest")

    if p.stage == ConversationStage.CLOSE:
        return _decision(Tactic.ASSUMPTIVE_CLOSE, "stage is CLOSE — proceed to logistics")

    # 3. Discovery openers --------------------------------------------------
    if p.stage == ConversationStage.INTRO and p.turn_count <= 1:
        return _decision(Tactic.ASK_OPEN, "INTRO stage, opening turn — discover before pitching")

    # Honest disqualification when intent is genuinely unclear early in the call.
    # Counterintuitive trust-builder: agent that doesn't *need* the sale gets it.
    if p.score < 35 and p.turn_count <= 2 and not p.objection_type:
        return _decision(
            Tactic.ASK_DISQUALIFY,
            "low score early with no clear objection — give them an out, build trust",
        )

    # 4. Objection-specific paths -------------------------------------------
    prior_price_count = p.prior_objection_types.count(ObjectionType.PRICE)
    prior_trust_count = p.prior_objection_types.count(ObjectionType.TRUST)
    prior_timing_count = p.prior_objection_types.count(ObjectionType.TIMING)
    discounts_count = len(p.discounts_offered)

    if p.objection_type == ObjectionType.PRICE:
        # First PRICE mention → ISOLATE (confirm it's the only blocker)
        if prior_price_count == 0:
            return _decision(Tactic.ISOLATE, "first PRICE mention — isolate before reframing")

        # Subtype-driven branches for repeated PRICE
        if p.objection_subtype in {"budget", "found_cheaper"} and p.has_alternative_product:
            return _decision(
                Tactic.ALTERNATIVE_PIVOT,
                f"repeated PRICE / {p.objection_subtype} with alternative available",
            )

        # Concession ladder — only after we've isolated and reframed at least once
        if prior_price_count >= 2 and discounts_count < 2:
            tier = "first 5%" if discounts_count == 0 else "second 10% (final)"
            return _decision(
                Tactic.CONCESSION_REAL,
                f"PRICE raised {prior_price_count + 1} times — concession ladder ({tier})",
            )

        # Discount cap reached and still resisting — last-line value reframe
        if discounts_count >= 2:
            return _decision(
                Tactic.PERMISSION_PUSH,
                "max discount given but still resisting — earn permission to push back",
            )

        return _decision(Tactic.REFRAME, "second PRICE mention — reframe before any concession")

    if p.objection_type == ObjectionType.TRUST:
        if prior_trust_count == 0:
            return _decision(Tactic.ASK_OPEN, "first TRUST mention — uncover the specific concern")
        return _decision(
            Tactic.CONCESSION_NON_MONETARY,
            "repeated TRUST — offer warranty / refund / proof to remove perceived risk",
        )

    if p.objection_type == ObjectionType.TIMING:
        # 'spouse_decision', 'wait_for_sale', 'not_now', 'comparison_shopping' all
        # respond best to capturing the real decision moment rather than fighting it.
        if p.objection_subtype == "wait_for_sale" and discounts_count == 0:
            return _decision(
                Tactic.CONCESSION_REAL,
                "waiting for a sale — small concession now beats waiting for one later",
            )
        if prior_timing_count == 0:
            return _decision(Tactic.TIME_CAPTURE, "first TIMING — capture the natural decision moment")
        return _decision(
            Tactic.PERMISSION_PUSH,
            "repeated TIMING — earn the right to ask one more diagnostic question",
        )

    if p.objection_type == ObjectionType.CONFUSION:
        # Mirror first to make them elaborate; on repeat, ask an open question to probe.
        if p.objection_subtype in {"how_works", "comparison_unclear", "fit_size"}:
            return _decision(Tactic.ASK_OPEN, "specific informational gap — ask what they need to know")
        return _decision(Tactic.MIRROR, "general confusion — mirror so they elaborate")

    # 5. Fallback -----------------------------------------------------------
    return _decision(Tactic.ASK_OPEN, "no decisive signal — deepen understanding")


def _decision(tactic: Tactic, reasoning: str) -> Decision:
    return Decision(tactic=tactic, reasoning=reasoning, micro_guidance=micro_guidance(tactic))
