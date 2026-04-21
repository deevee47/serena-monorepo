from openai import AsyncOpenAI

from app.config.settings import settings

FEW_SHOT_EXAMPLES = [
    ("That's too expensive for me", "PRICE NEGATIVE"),
    ("The price is a bit high but I like the product", "PRICE POSITIVE"),
    ("I'm not sure if I can trust this brand", "TRUST NEGATIVE"),
    ("I've read good reviews but still a bit unsure", "TRUST NEUTRAL"),
    ("I don't really understand what this does", "CONFUSION NEGATIVE"),
    ("Can you explain the main features again?", "CONFUSION NEUTRAL"),
    ("I'm not ready to buy right now", "TIMING NEGATIVE"),
    ("Maybe next month would be better", "TIMING NEUTRAL"),
    ("That sounds great, I'm interested!", "POSITIVE_SIGNAL POSITIVE"),
    ("Okay, tell me more", "POSITIVE_SIGNAL NEUTRAL"),
    ("Hmm", "NEUTRAL NEUTRAL"),
    ("I see", "NEUTRAL NEUTRAL"),
]

VALID_TYPES = {"PRICE", "TRUST", "CONFUSION", "TIMING", "POSITIVE_SIGNAL", "NEUTRAL"}
VALID_SENTIMENTS = {"POSITIVE", "NEGATIVE", "NEUTRAL"}


async def classify_objection(utterance: str, stage: str, score: int, call_id: str) -> tuple[str, str, float]:
    """Returns (objection_type, sentiment, confidence)."""
    client = AsyncOpenAI(api_key=settings.llm_api_key)

    messages: list[dict] = [
        {
            "role": "system",
            "content": (
                "You are a sales call objection classifier. "
                "Classify the customer's statement into exactly one objection type and one sentiment. "
                "Respond with exactly two words on one line: OBJECTION_TYPE SENTIMENT.\n"
                "Objection types: PRICE, TRUST, CONFUSION, TIMING, POSITIVE_SIGNAL, NEUTRAL\n"
                "Sentiments: POSITIVE, NEGATIVE, NEUTRAL"
            ),
        },
    ]
    for utterance_ex, label in FEW_SHOT_EXAMPLES:
        messages.append({"role": "user", "content": utterance_ex})
        messages.append({"role": "assistant", "content": label})
    messages.append({"role": "user", "content": utterance})

    response = await client.chat.completions.create(
        model=settings.openai_classifier_model,
        messages=messages,
        max_tokens=20,
        temperature=0,
    )

    raw = (response.choices[0].message.content or "NEUTRAL NEUTRAL").strip().upper()
    parts = raw.split()

    objection_type = parts[0] if len(parts) >= 1 and parts[0] in VALID_TYPES else "NEUTRAL"
    sentiment = parts[1] if len(parts) >= 2 and parts[1] in VALID_SENTIMENTS else "NEUTRAL"
    confidence = 1.0 if objection_type != "NEUTRAL" or raw == "NEUTRAL NEUTRAL" else 0.5

    return objection_type, sentiment, confidence
