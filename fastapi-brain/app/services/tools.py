"""OpenAI tool definitions exposed to the agent LLM.

Two tools for v1:
  - send_whatsapp_checkout_link: real side effect (sends WhatsApp checkout link)
  - send_whatsapp_product_info: real side effect (sends WhatsApp product info)

Pydantic models double as the JSON schemas the LLM sees. The integer bound on
discount_percent is the contract — modern models almost never violate it.
The /converse route validates parsed args against these models and rejects
or coerces invalid calls; the gateway clamps as a final belt-and-suspenders.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

# Keep in sync with prompt_sections.MAX_DISCOUNT.
MAX_DISCOUNT_PERCENT = 10


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


# Tool name → its Pydantic args model. Used at parse time to validate the
# args returned by the model.
TOOL_ARG_MODELS: dict[str, type[BaseModel]] = {
    "send_whatsapp_checkout_link": SendCheckoutLinkArgs,
    "send_whatsapp_product_info": SendProductInfoArgs,
}

ToolName = Literal["send_whatsapp_checkout_link", "send_whatsapp_product_info"]


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


__all__ = [
    "MAX_DISCOUNT_PERCENT",
    "OPENAI_TOOLS",
    "ParsedToolCall",
    "SendCheckoutLinkArgs",
    "SendProductInfoArgs",
    "ToolName",
    "TOOL_ARG_MODELS",
    "parse_tool_call",
    "ValidationError",
]
