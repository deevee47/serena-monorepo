# Serena Voice Agent — AI Engineer Interview Prep

> Voice AI cart-abandonment recovery. The interviewer will grill the **voice pipeline, latency, the LLM layer, and the gap between your resume bullets and the actual code.** Go depth-by-depth: broad → specific → "prove it" → "now scale/break it."

## ⚠️ The #1 Rule
For every resume bullet ("sentiment detection," "filler words," "dynamic tone," "cross-sell"), assume they ask **"how exactly did you implement that?"** Interviewers hunt the gap between claim and code. **Never bluff a mechanism you didn't build** — say what you actually did. Bluffing is how you fail the follow-up.

---

## Round 1 — "Walk me through the system" (architecture)

**Q: End-to-end flow of a single call?**

> Trigger (cart abandoned event) → outbound call via telephony (Vapi/Telnyx) → audio streams in → **STT** transcribes → my **LLM gateway** builds context (customer profile, cart, purchase history) and streams a completion → **TTS** (ElevenLabs) speaks back → barge-in/endpointing manages turn-taking → outcome + transcript + metrics logged to dashboard.

**Escalations:**
- *"Where does latency come from?"* → STT finalization + LLM time-to-first-token + TTS time-to-first-byte + network. (This IS the interview — see Round 3.)
- *"Why Vapi AND Telnyx? Why not build the media stack?"* → Vapi orchestrates STT/LLM/TTS + telephony so you ship fast; Telnyx for direct SIP/PSTN control + cost. Trade-off = less control vs. faster delivery.

---

## Round 2 — The LLM Layer (your "gateway")

**Q: Walk me through your gateway. What does it do?**
Builds prompt/context, calls the LLM, **streams** tokens out, handles tool/function calls, caches lookups. (Your commit: "crash-proof LLM stream" — talk about it.)

**Escalations:**
- **"How do you construct context?"** → System prompt (persona/goal/guardrails) + structured customer data (name, cart items, price, abandonment reason) + conversation history. Know whether you inject raw or summarize.
- **"Is this RAG?"** → Only say RAG if you retrieve from a vector store. Cart recovery is usually **structured context injection, NOT RAG.** Don't call a DB lookup "RAG" — classic trap.
- **"How does function-calling work?"** → e.g. `check_inventory`, `apply_discount`, `book_callback`. Model emits tool call → you execute → feed result back → model continues. Resume tracks "tools called" — **know your tool list cold.**
- **"Why did the stream crash and how'd you fix it?"** → You have commit `fix(gateway): crash-proof LLM stream`. **This is a gift — know the story** (partial chunks? malformed tool-call delta JSON? provider disconnect mid-stream?).

---

## Round 3 — LATENCY (where you win or lose) 🎯

Target: **sub-800ms, ideally ~500ms** turn-to-turn, or it feels robotic.

**Q: What's your latency and how do you measure it?**
> I anchor measurement on the provider's **`speech.boundary` / `speech-update` events** (Vapi needs `speech-update` in serverMessages), with a **TTS-estimate fallback.** — Lead with this; it's a senior-level answer.

**Escalations:**
- **"Break down the latency budget."** → STT endpointing delay + LLM TTFT + TTS TTFB + network round-trips.
- **"How do you cut it?"**
  - **Stream everything** — pipe tokens to TTS as sentences complete; don't wait for full completion.
  - **Smart endpointing** (you shipped this) — detect end-of-turn fast without cutting the user off.
  - **Filler words / openers** (you shipped this) — "let me check that for you…" masks latency while LLM/tool runs. **Frame it as a latency-hiding trick, not just personality.**
  - **Cache lookups** (you did: "cache alternative lookups").
  - Smaller/faster model or shorter prompt for the first turn.
- **"Trade-off of aggressive endpointing?"** → Cut the user off vs. dead air. You tune the silence threshold.

> Nail this round = you look senior.

---

## Round 4 — Resume-Bullet Grilling (prove your claims)

They go one by one. Have a REAL mechanism for each:

| Claim | They'll ask | Have an answer for |
|---|---|---|
| **Sentiment detection** | "Real-time or post-call? What model?" | LLM-inferred per turn? Classifier? Keyword? Say the truth. |
| **Dynamic tone adoption** | "How does tone actually change?" | Prompt conditioned on sentiment? Branching system prompts? |
| **Filler words** | "Why, and how?" | Latency masking + naturalness; injected in TTS/openers. |
| **Cross-sell / upsell** | "How does it decide what to offer?" | Rules on cart/history? LLM-driven? |
| **Bilingual openers** | "How do you pick language?" | You shipped this — know the detection/selection logic. |
| **Recovery rate / analytics** | "How is 'recovery' defined and attributed?" | Call outcome → conversion mapping. Define precisely. |

> **Trap:** If "sentiment trends" is just the LLM outputting a label, *say that.* "I have the LLM classify sentiment per turn and log it" is a great honest answer. Inventing a fine-tuned model = destroyed on the follow-up.

---

## Round 5 — Reliability & Edge Cases (breaking it)

**Q: Agent offers a discount that doesn't exist. How do you prevent it?**
→ Guardrails in system prompt, **tool-grounding** (fetch prices, don't invent), constrained offers, refusal patterns. **This is a hallucination question — name it.**

**Q: What happens on…**
- **Voicemail / IVR?** → detection + leave message or hang up.
- **Barge-in (user interrupts)?** → stop TTS, re-listen.
- **Silence / no response?** → reprompt, then graceful exit.
- **API failure mid-call?** → crash-proof stream story; retry/fallback; fail gracefully.
- **STT mishears?** → confirmation patterns for critical info.

---

## Round 6 — Evaluation (the senior signal)

**Q: How do you know the agent is good? How do you test changes?**
Most candidates are weak here — be strong:
- **Offline:** transcript review, simulated calls, **LLM-as-judge** on conversation quality, regression scenario set.
- **Online:** recovery rate, call duration, completion rate, sentiment, human spot-checks.
- **"How do you A/B a prompt change?"** → split traffic, compare recovery rate, watch regressions.
- Honest fallback: *"Eval was mostly manual transcript review + recovery-rate tracking; a formal eval harness is my next build."* — a great answer.

---

## Round 7 — Cost, Scale, Compliance ("now run it in prod")

- **Cost per call:** STT + LLM tokens + TTS chars + telephony minutes. **TTS + telephony usually dominate.** Be ready to estimate.
- **Concurrency:** "100 simultaneous calls — what breaks?" → provider concurrency limits, gateway throughput, DB writes. Queue/rate-limit outbound.
- **Compliance:** outbound calling = **TCPA/consent**, call-recording **two-party consent**, **PII** handling of customer/purchase data. Even "I'm aware of TCPA + consent" shows maturity.

---

## 📌 Numbers & Facts to Memorize Before You Walk In
- Your **latency** figure (approx) + its breakdown.
- Exact **stack**: Vapi vs Telnyx roles, ElevenLabs TTS, which LLM, gateway in Bun/TS.
- Your **tool/function list**.
- Your definition of **"recovery rate."**
- The **crash-proof stream** story (root cause + fix).
- The **endpointing/filler** latency story.

## 🛟 Handling What You Don't Know
Say: **"I didn't implement that, but here's how I'd approach it…"** A clean boundary + good reasoning beats a confident wrong answer. The fastest way to fail a voice-AI interview is bluffing a mechanism and getting unwound on the follow-up.
