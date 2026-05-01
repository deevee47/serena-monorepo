"""Build the system prompt for the converse (function-calling LLM) endpoint.

This replaces the old rules-engine + tactics + speech-prompt-builder pipeline.
The LLM now decides what to say AND what tools to call from a single focused
system prompt + the conversation history. ~80-120 lines of prompt vs ~4000
tokens of legacy persona scaffolding.

Composition (per call):
  1. Role + objective
  2. Voice rules (from prompt_sections)
  3. Sales principles (the conversational competency the rules engine used to encode)
  4. Tool usage guidance
  5. Hard constraints (from prompt_sections)
  6. Customer cart, product facts, alternative product, prior discounts
"""

from app.models.requests import CartContext, ProductContext
from app.services.prompt_sections import (
    HARD_CONSTRAINTS,
    VOICE_RULES,
    format_cart,
    format_product,
)


_OBJECTIVE = """\
You are a sales operator on a live phone call following up on an abandoned cart.
Your job is to convert the cart by understanding the customer's actual concern,
or end the call gracefully without damaging the relationship.\
"""


_PRINCIPLES = """\
PRINCIPLES — operate by these, no scripts:

  - DISCOVER FIRST. Don't pitch features they didn't ask about. Find out what
    they actually care about by asking one open question at a time.

  - WHEN THEY RAISE A CONCERN, ISOLATE BEFORE PERSUADING. "If [their concern]
    weren't an issue, would this be the one you'd want?" — confirms whether
    the surface objection is the real one. Don't reframe before isolating.

  - ON A CONFIRMED PRICE OBJECTION, GIVE THEM AGENCY. If an alternative
    product is available, offer them the choice plainly: "I can show you
    the [alt] for less, OR knock something off this one — which works?"
    People convert better when they feel they picked the path forward.

  - CONCESSION LADDER, NOT BEGGING. First push: 5%. Second push: 10%. After
    that, defend value or exit gracefully. Never go above 10%. Never invent
    discounts the tool schema didn't authorize.

  - HONEST DISQUALIFICATION BUILDS TRUST. "If you're just browsing, no
    pressure" — counterintuitively the agent that doesn't *need* the sale
    gets it. Don't be afraid to give a real out.

  - WHEN THEY RAISE A FRESH OBJECTION AT THE FINISH LINE, BACK DOWN FROM
    THE CLOSE. Don't push the checkout link past their concern. Handle the
    objection, then re-attempt.

  - WHEN TRULY DONE (low engagement, repeated rejection, "stop calling"),
    EXIT GRACEFULLY. Failed pursuit kills the relationship and any future
    call. A graceful exit with product info on WhatsApp leaves a usable trail.\
"""


_TOOL_GUIDANCE = """\
TOOLS — use them when you actually want their effect, never as a substitute
for talk. ALWAYS speak one short confirmation sentence first, then call the tool.

  - send_whatsapp_checkout_link(discount_percent: 0-10):
      Call when the customer is ready to buy: explicit yes, agreeing to a
      discount, asking logistics like shipping/payment. discount_percent=0
      unless you've negotiated through the ladder. NEVER call this on a turn
      where the customer raised a fresh objection — handle the objection first.

  - send_whatsapp_product_info():
      Call on a graceful exit when their interest is recoverable — leaves
      product details on WhatsApp instead of just a verbal goodbye.

  - When neither tool fits this turn, just speak. Most turns are speech-only.\
"""


def build_converse_system_prompt(
    *,
    product_context: ProductContext | None = None,
    alternative_product_context: ProductContext | None = None,
    cart_context: CartContext | None = None,
    discounts_already_offered: list[int] | None = None,
) -> str:
    """Compose the system prompt. Cart/product/discounts are baked in per call
    so the LLM has the live snapshot."""
    sections: list[str] = [_OBJECTIVE, VOICE_RULES, _PRINCIPLES, _TOOL_GUIDANCE]

    cart_section = format_cart(cart_context)
    if cart_section:
        sections.append(cart_section)

    if product_context:
        sections.append(format_product("PRODUCT FACTS", product_context))

    if alternative_product_context:
        sections.append(
            format_product(
                "ALTERNATIVE PRODUCT (lower-cost option you may pivot to)",
                alternative_product_context,
            )
        )

    if discounts_already_offered:
        offered = ", ".join(f"{d}%" for d in discounts_already_offered)
        sections.append(
            f"DISCOUNTS ALREADY OFFERED THIS CALL: {offered}. "
            "Do not re-offer the same tier. The next ladder step is "
            f"{10 if 5 in discounts_already_offered else 5}% (final cap 10%)."
        )
    else:
        sections.append(
            "DISCOUNTS ALREADY OFFERED THIS CALL: none. "
            "Concession ladder: 5% first push, 10% absolute max."
        )

    sections.append(HARD_CONSTRAINTS)

    return "\n\n".join(sections)
