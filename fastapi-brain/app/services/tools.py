"""OpenAI tool definitions exposed to the agent LLM.

Two categories:

1. **Side-effect tools** (return None to the LLM, dispatched by gateway):
     - send_whatsapp_checkout_link  — fires real WhatsApp send
     - send_whatsapp_product_info   — fires real WhatsApp send
   These end the LLM's turn. The agent says one confirmation sentence and
   then calls the tool; the gateway handles the actual side effect.

2. **Observation tools** (return real data to the LLM, executed server-side):
     - check_inventory       — real stock count + restock ETA
     - get_recent_purchases  — real purchase count over a window
     - get_review_summary    — real review count + avg + sample quote
     - get_delivery_eta      — delivery days for a zip code
   The brain runs these inline; the model gets the result back as a tool
   message and continues generating with grounded facts.

Pydantic models double as the JSON schemas the LLM sees.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

# Keep in sync with prompt_sections.MAX_DISCOUNT.
MAX_DISCOUNT_PERCENT = 10


# ─── Side-effect tool args ────────────────────────────────────────────────


class SendCheckoutLinkArgs(BaseModel):
    discount_percent: int = Field(
        default=0,
        ge=0,
        le=MAX_DISCOUNT_PERCENT,
        description=(
            f"Discount percent to apply on the checkout link, 0-{MAX_DISCOUNT_PERCENT}. "
            "Use 0 by default. Only use 5-10 when the customer has pushed back "
            "on price and the concession ladder is appropriate (5 first, 10 max)."
        ),
    )


class SendProductInfoArgs(BaseModel):
    pass


# ─── Observation tool args ────────────────────────────────────────────────


class CheckInventoryArgs(BaseModel):
    product_id: str = Field(description="The product_id to check (must match PRODUCT FACTS / ALTERNATIVE PRODUCT).")


class GetRecentPurchasesArgs(BaseModel):
    product_id: str = Field(description="The product_id to count purchases for.")
    days: int = Field(default=30, ge=1, le=365, description="Look-back window in days. Default 30.")


class GetReviewSummaryArgs(BaseModel):
    product_id: str = Field(description="The product_id to summarize reviews for.")


class GetDeliveryEtaArgs(BaseModel):
    zip_code: str = Field(min_length=5, max_length=10, description="US ZIP code (5 digits, optionally ZIP+4).")
    product_id: str = Field(description="The product_id (delivery time can vary by warehouse).")


class GetAvailableOffersArgs(BaseModel):
    product_id: str = Field(
        description=(
            "The product_id to fetch active promotional offers for. Returns "
            "BUNDLE offers (buy X with Y for N% off) and QUANTITY offers "
            "(buy 2+ for N% off) — pre-authorized by the business."
        ),
    )


# Tool name → its Pydantic args model.
TOOL_ARG_MODELS: dict[str, type[BaseModel]] = {
    "send_whatsapp_checkout_link": SendCheckoutLinkArgs,
    "send_whatsapp_product_info": SendProductInfoArgs,
    "check_inventory": CheckInventoryArgs,
    "get_recent_purchases": GetRecentPurchasesArgs,
    "get_review_summary": GetReviewSummaryArgs,
    "get_delivery_eta": GetDeliveryEtaArgs,
    "get_available_offers": GetAvailableOffersArgs,
}

ToolName = Literal[
    "send_whatsapp_checkout_link",
    "send_whatsapp_product_info",
    "check_inventory",
    "get_recent_purchases",
    "get_review_summary",
    "get_delivery_eta",
    "get_available_offers",
]

# Side-effect tools end the LLM turn — gateway dispatches, no result back.
SIDE_EFFECT_TOOLS: set[str] = {
    "send_whatsapp_checkout_link",
    "send_whatsapp_product_info",
}

# Observation tools are executed server-side; result is fed back to the LLM.
OBSERVATION_TOOLS: set[str] = {
    "check_inventory",
    "get_recent_purchases",
    "get_review_summary",
    "get_delivery_eta",
    "get_available_offers",
}


# OpenAI Chat Completions API "tools" payload.
OPENAI_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "send_whatsapp_checkout_link",
            "description": (
                "Send a checkout link to the customer's WhatsApp. Call this when "
                "the customer is ready to buy — explicit yes, agreeing to a "
                "discount, asking logistics like shipping or payment methods, or "
                "after they've made a clear commitment. ALWAYS speak ONE short "
                "confirmation sentence first ('sending it to your WhatsApp now'), "
                "then call this. Never call this on a turn where they raised a "
                "fresh objection."
            ),
            "parameters": SendCheckoutLinkArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_whatsapp_product_info",
            "description": (
                "Send product details to the customer's WhatsApp WITHOUT a "
                "checkout link. Call this when a graceful exit is appropriate "
                "but their interest is still recoverable — leaves a usable trail "
                "instead of a verbal goodbye. Speak one short sentence first "
                "('shooting the details over now, no rush')."
            ),
            "parameters": SendProductInfoArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_inventory",
            "description": (
                "Check real, current inventory for a product. Returns "
                "{ in_stock: int, low_stock: bool, restock_eta_days: int | null }. "
                "Use this when honest scarcity would persuade — e.g. a hesitating "
                "customer asking 'how many are left?' or when you want to mention "
                "low stock as a real fact (NOT as fake urgency). Do NOT mention "
                "stock numbers unless this tool returns them."
            ),
            "parameters": CheckInventoryArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_purchases",
            "description": (
                "Count how many of this product were purchased in the last N days. "
                "Returns { count: int, days: int }. Use this for HONEST social "
                "proof — 'we've shipped 47 of these in the last 30 days' — only "
                "when the count is high enough to actually persuade. Do NOT "
                "fabricate or round up the number."
            ),
            "parameters": GetRecentPurchasesArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_review_summary",
            "description": (
                "Get a real summary of customer reviews. Returns { count: int, "
                "avg_rating: float, top_positive_quote: str | null, "
                "top_critical_quote: str | null }. Use when the customer asks "
                "about quality, doubts the product, or wants to know what others "
                "think. Quote reviewers verbatim — do NOT paraphrase or invent."
            ),
            "parameters": GetReviewSummaryArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_delivery_eta",
            "description": (
                "Get the real delivery ETA for a product to a ZIP code. Returns "
                "{ standard_days: int, expedited_days: int }. Use when the "
                "customer asks about shipping or when a fast delivery is a "
                "closing lever (e.g. they need it before a date)."
            ),
            "parameters": GetDeliveryEtaArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_available_offers",
            "description": (
                "Get the active promotional offers attached to a product — "
                "BUNDLE offers (buy this with another product for N% off) and "
                "QUANTITY offers (buy ≥N for N% off). Returns "
                "{ offers: [{type, discount_percent, short_pitch, "
                "bundle_product?, min_quantity?}] }. CALL THIS BEFORE giving a "
                "flat negotiation discount on a price objection — pre-authorized "
                "offers are stronger than ad-hoc concessions because they "
                "increase order value, not just margin. If no offers exist or "
                "none fit the customer's situation, then fall back to the "
                "discount ladder. Do NOT invent an offer the tool didn't return."
            ),
            "parameters": GetAvailableOffersArgs.model_json_schema(),
        },
    },
]


class ParsedToolCall(BaseModel):
    """Validated tool call ready for the gateway to dispatch."""
    name: ToolName
    args: dict[str, Any]


def parse_tool_call(name: str, raw_args: dict[str, Any]) -> ParsedToolCall:
    """Validate the LLM's tool-call args against the registered Pydantic model.

    Raises ValidationError if the model returned something out of range
    (e.g. discount_percent=15) or an unknown tool name. Callers should
    catch and decide between coerce / reject / fallback-to-text.
    """
    if name not in TOOL_ARG_MODELS:
        raise ValueError(f"unknown tool name: {name!r}")
    model_cls = TOOL_ARG_MODELS[name]
    validated = model_cls(**raw_args)
    return ParsedToolCall(name=name, args=validated.model_dump())  # type: ignore[arg-type]


def is_observation_tool(name: str) -> bool:
    return name in OBSERVATION_TOOLS


def is_side_effect_tool(name: str) -> bool:
    return name in SIDE_EFFECT_TOOLS


__all__ = [
    "MAX_DISCOUNT_PERCENT",
    "OBSERVATION_TOOLS",
    "OPENAI_TOOLS",
    "ParsedToolCall",
    "SIDE_EFFECT_TOOLS",
    "SendCheckoutLinkArgs",
    "SendProductInfoArgs",
    "ToolName",
    "TOOL_ARG_MODELS",
    "ValidationError",
    "is_observation_tool",
    "is_side_effect_tool",
    "parse_tool_call",
]
