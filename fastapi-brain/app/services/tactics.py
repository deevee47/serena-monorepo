"""The tactic library — named conversational moves the agent can make.

Each tactic is a discrete move (not a personality trait). The Decision layer
picks one per turn based on Perception + state; the Speech layer expresses it
as natural language using the per-tactic micro-guidance below.

The micro-guidance is the *only* tactic-specific text the speech prompt sees
for a given turn. Keep each block 3-5 lines; voice rules live elsewhere.
"""

from dataclasses import dataclass
from enum import StrEnum


class Tactic(StrEnum):
    ASK_OPEN = "ASK_OPEN"
    ASK_DISQUALIFY = "ASK_DISQUALIFY"
    MIRROR = "MIRROR"
    ISOLATE = "ISOLATE"
    REFRAME = "REFRAME"
    CONCESSION_REAL = "CONCESSION_REAL"
    CONCESSION_NON_MONETARY = "CONCESSION_NON_MONETARY"
    ALTERNATIVE_PIVOT = "ALTERNATIVE_PIVOT"
    PERMISSION_PUSH = "PERMISSION_PUSH"
    TIME_CAPTURE = "TIME_CAPTURE"
    TRIAL_CLOSE = "TRIAL_CLOSE"
    ASSUMPTIVE_CLOSE = "ASSUMPTIVE_CLOSE"
    GRACEFUL_EXIT = "GRACEFUL_EXIT"
    # Tool-call tactics — picked when the agent has an actual mechanism to
    # follow through with (e.g. WhatsApp). The Speech layer makes the agent
    # confirm the action naturally; the gateway fires the real send.
    SEND_CHECKOUT_LINK_WHATSAPP = "SEND_CHECKOUT_LINK_WHATSAPP"
    SEND_PRODUCT_INFO_WHATSAPP = "SEND_PRODUCT_INFO_WHATSAPP"


@dataclass(frozen=True)
class Decision:
    tactic: Tactic
    reasoning: str  # one sentence — goes to logs and tactic-attribution analytics
    micro_guidance: str  # 3-5 lines; the only tactic-specific text in the Speech prompt


# ---------------------------------------------------------------------------
# Per-tactic micro-guidance. These are the only tactic-specific lines the
# Speech-layer prompt will see — keep them tight, voice-natural, and free of
# persona scaffolding.
# ---------------------------------------------------------------------------

MICRO_GUIDANCE: dict[Tactic, str] = {
    Tactic.ASK_OPEN: (
        "Ask one open question that surfaces what they actually care about.\n"
        "Not a yes/no. Not a leading question. Genuinely curious.\n"
        "After the question: stop talking."
    ),
    Tactic.ASK_DISQUALIFY: (
        "Give them an explicit out — 'if you're just browsing, no pressure.'\n"
        "This builds trust because it shows you don't need the sale.\n"
        "If they take the out, accept it gracefully. If they push back into\n"
        "engagement, that's the strongest buying signal you can get."
    ),
    Tactic.MIRROR: (
        "Reflect their last 3-5 words back as a question.\n"
        "No reframing, no opinion — just hand the conversation back.\n"
        "This makes them elaborate and feel heard."
    ),
    Tactic.ISOLATE: (
        "Confirm this objection is the *only* blocker.\n"
        "Frame: 'if [their concern] worked, would this be the one?'\n"
        "If yes — you have a clear path. If no — find the real objection."
    ),
    Tactic.REFRAME: (
        "Shift the frame, don't argue. Cost → daily/weekly investment.\n"
        "Feature → outcome. Risk → comparison to status quo cost.\n"
        "One reframe, one sentence. Don't stack."
    ),
    Tactic.CONCESSION_REAL: (
        "Offer the available real discount, plainly. No 'let me check with\n"
        "my manager' theatre. Frame as final: 'I can do X% — that's it.'\n"
        "Then stop talking. Whoever speaks first loses."
    ),
    Tactic.CONCESSION_NON_MONETARY: (
        "Offer a non-price concession that addresses their real concern:\n"
        "free shipping, extended warranty, white-glove setup, easy returns.\n"
        "Match the concession to their objection — don't shotgun."
    ),
    Tactic.ALTERNATIVE_PIVOT: (
        "Honestly suggest the cheaper alternative. 'It's a different product,\n"
        "but it handles [their core need].' Frame as a real choice, not a\n"
        "downsell trick. They'll trust you more for this."
    ),
    Tactic.PERMISSION_PUSH: (
        "Ask permission before pushing back. 'Can I push back on one thing?'\n"
        "Inverts the power dynamic — they grant you the floor.\n"
        "Then make exactly one specific point. Stop."
    ),
    Tactic.TIME_CAPTURE: (
        "Don't fight the timing — capture a real decision moment.\n"
        "'When would you naturally decide on something like this?'\n"
        "Then offer to follow up at exactly that time. Honor it."
    ),
    Tactic.TRIAL_CLOSE: (
        "Soft commitment test that doesn't require a yes/no.\n"
        "'Sounds like the medium would be the fit — sound right?'\n"
        "Their answer tells you exactly how close they are."
    ),
    Tactic.ASSUMPTIVE_CLOSE: (
        "Proceed as if the decision is made. Move to logistics:\n"
        "'I'll get the order started — what's the best email for the receipt?'\n"
        "If they want to back out, they will. Most won't."
    ),
    Tactic.GRACEFUL_EXIT: (
        "Release them. No last-ditch pitch, no guilt, no urgency.\n"
        "'All good — I'll send a link, use it whenever.'\n"
        "Failed pursuit kills the relationship and any future call."
    ),
    Tactic.SEND_CHECKOUT_LINK_WHATSAPP: (
        "Confirm — naturally — that you're sending a checkout link to their\n"
        "WhatsApp right now. Specific and short: 'Sending you the checkout\n"
        "link on WhatsApp now — should land in a few seconds.'\n"
        "Do NOT ask for permission. Do NOT re-pitch. State the action."
    ),
    Tactic.SEND_PRODUCT_INFO_WHATSAPP: (
        "Tell them you're sending the product details to their WhatsApp so\n"
        "they can decide on their own time. No pressure, no urgency.\n"
        "'Cool — shooting the product details to your WhatsApp now. Look\n"
        "it over whenever, no rush.'"
    ),
}


def micro_guidance(tactic: Tactic) -> str:
    return MICRO_GUIDANCE[tactic]
