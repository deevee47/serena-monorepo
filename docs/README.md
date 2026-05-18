# Serena — Code Walkthrough

A study guide for the codebase. Each file in this folder is a deep-dive on one slice of the system, with **actual code excerpts and line numbers** so you can read the doc and the code side by side.

## How to read this

Pick the order that matches how you think:

### Path A — Top-down (recommended for first read)
1. **[../ARCHITECTURE_STUDY.md](../ARCHITECTURE_STUDY.md)** — the map. What the system is, why two services, what each subsystem does.
2. **[01-runtime-flow.md](01-runtime-flow.md)** — what happens per turn, end-to-end. Walk a phone-call utterance from Vapi → gateway → brain → LLM → response.
3. **[02-data-and-tools.md](02-data-and-tools.md)** — the data model + the observation tools that hit Postgres. How the agent gets real facts (reviews, inventory, offers) instead of fabricating.
4. **[03-prompt-and-conversion.md](03-prompt-and-conversion.md)** — the system prompt that drives the agent's behavior: voice rules, persistent probe, offers ladder, hard-no list, the whole conversion playbook.

### Path B — Bottom-up (if you've already read parts of the code)
- Read the file you're confused about, then jump to the corresponding section here for context.
- Each doc cross-references the others so you can hop around.

## Prerequisites

You should be comfortable with:
- TypeScript + async/await
- Python async/await
- Prisma (the ORM, the schema language, `migrate deploy`)
- The OpenAI Chat Completions API + function-calling format
- Server-Sent Events (SSE)

You don't need to know:
- Vapi specifics — explained as we go
- BullMQ specifics — explained as we go

## Filename conventions

- `[file.ts:N](path/file.ts#LN)` — clickable link to a specific line. Open in your IDE / GitHub.
- Code blocks show **excerpts**, not always full files. Open the file in your IDE for full context.
- Snippets track the current implementation, including the `feat/human-feel-pacing`
  work (live customer/cart context, sentiment-adaptive prompts, thinking fillers,
  voice tuning). Line numbers drift as code changes — treat them as a starting
  point, not gospel.

## History

- [history/BUILD_GUIDE.md](history/BUILD_GUIDE.md) — the original pre-pivot
  "engineering master spec." **Superseded.** It describes a deterministic
  rules-engine architecture ("the LLM is a voice synthesis layer, not a brain")
  that was deleted and replaced by the single function-calling LLM. Kept for
  project history only — see [../ARCHITECTURE_STUDY.md](../ARCHITECTURE_STUDY.md)
  and [../CONVERSION_ENGINE.md](../CONVERSION_ENGINE.md) for current truth.
