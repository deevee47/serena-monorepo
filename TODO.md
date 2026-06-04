# Telnyx Migration — dev → prod hardening

Active tracker for things deliberately left loose in dev that **must** be tightened before customer traffic hits Telnyx. Migration plan reference: `~/.claude/plans/we-are-currently-using-greedy-yeti.md`.

---

## 🔴 Blockers (must fix before any production traffic)

- [ ] **Re-enable Ed25519 webhook signature verification.**
      Remove `TELNYX_INSECURE_DEV=1` from `.env`. The `TelnyxProvider.verifyWebhook` short-circuits when it's set — see `node-gateway/src/services/voice-provider/telnyx-provider.ts`. Verify by sending a webhook with no signature header and confirming it returns 401.

- [ ] **Set `TELNYX_LLM_SHARED_SECRET`** in `.env` AND in the Telnyx assistant's Custom-LLM `Authorization` config.
      Currently `TelnyxProvider.verifyLlmAuth` falls open when the env var is unset (see `telnyx-provider.ts`). With it set, the gateway compares the Bearer token with timing-safe `crypto.timingSafeEqual`.

- [ ] **Tighten the legacy `/vapi-llm/chat/completions` route.**
      Currently aliased to the same handler as `/llm/chat/completions` for backwards compat. Once the Vapi assistant config is repointed at the canonical path, delete the alias in `node-gateway/src/routes/llm.ts`.

- [ ] **Confirm Telnyx India outbound is enabled** (KYC + Outbound Voice Profile).
      Highest blocker risk from the spike. Without it the Hindi cohort can't be migrated. See plan §13 unknown #1.

- [ ] **Provision a real Telnyx DID + telephony credential** for the prod cutover.
      Set `TELNYX_PHONE_NUMBER`, `TELNYX_PHONE_NUMBER_ID`, `TELNYX_TELEPHONY_CREDENTIAL_ID`. Once present, `TelnyxProvider.getWebClientConfig` auto-promotes from anonymous mode to JWT mode — no code change needed.

---

## 🟡 Hardening (do before the canary)

- [ ] **Per-locale Telnyx assistants** with baked-in pacing config.
      Set `TELNYX_ASSISTANT_EN` and `TELNYX_ASSISTANT_HI`. Each assistant's portal config carries: `silenceTimeoutSeconds=12`, `responseDelaySeconds=0.4`, `numWordsToInterruptAssistant=2`, `backchannelingEnabled=true`, locale-appropriate end-call phrases. `TelnyxProvider.createPhoneCall` already routes by locale via `assistantIdForLocale`.

- [x] **Server-side opener generation.** ✅ Done — `node-gateway/src/services/opener.service.ts` owns the weighted pool; `POST /calls/opener` exposes it; `TalkButtonVapi` fetches via `fetchOpenerAction`. Follow-up: extend the brain's first-turn rendering on the LLM endpoint to call `generateOpener` when the conversation history is empty, so Telnyx anonymous calls (which don't accept `firstMessage` from the client) also get the same opener instead of relying on assistant-side greetings.

- [ ] **Verify the `ai_assistant_start` action fires automatically** on `call.answered` for the prod Telnyx SIP connection.
      If the connection isn't pre-configured to invoke it, add a worker on the normalized `call.started` event that POSTs `/v2/calls/{id}/actions/ai_assistant_start`. See `services/voice-provider/telnyx-provider.ts::createPhoneCall` for the comment marking this.

- [ ] **End-to-end staging soak** with `TELNYX_INSECURE_DEV` UNSET.
      Place ≥5 real calls, verify: signature verification passes, `call.started → call.ended → recording.ready` all persist, recordings playable via `/calls/:id/recording`.

---

## 🟢 Decommission (T+30 days after 100% on Telnyx)

- [ ] Delete `node-gateway/src/services/voice-provider/vapi-provider.ts`.
- [ ] Delete `dashboard/src/components/talk-button-vapi.tsx` and the selector branch in `talk-button.tsx`.
- [ ] Delete the `ProviderSelector` UI from `page-header.tsx` and `lib/provider.ts` (no longer needed when there's only one provider).
- [ ] Delete `node-gateway/src/types/vapi.types.ts`.
- [ ] Delete the `/vapi-llm/chat/completions` route alias from `llm.ts`.
- [ ] Remove `@vapi-ai/web` from `dashboard/package.json`.
- [ ] Remove all `VAPI_*` env vars from `.env`, `.env.example`, deploy configs.
- [ ] Drop the `voice_provider` column from the `calls` table (or keep for historical audit — your call).
- [ ] Release the Vapi phone number, pause/delete the Vapi assistant in their portal.

---

## ⚠️ Known blocker: anonymous WebRTC dashboard test path

The `TalkButtonTelnyx` anonymous-mode flow connects to Telnyx's WebSocket, completes the SIP INVITE/ICE/SDP negotiation, gets to `ringing` state — but the AI Assistant never sends the SDP answer, so the call hangs at ringing indefinitely. Confirmed across:
- Custom LLM mode (`external_llm`) + hosted Kimi (`model`) — same symptom in both
- `supports_unauthenticated_web_calls: true` confirmed in assistant config
- Opus codec preferred per Telnyx docs, sent in newCall
- WebRTC SDK Verto debug logs show clean handshake up through `telnyx_rtc.ringing`
- Zero traffic reaches our gateway during the call (no webhooks, no LLM POSTs) — the assistant isn't reaching out
- Telnyx's "Validate LLM connection" probe works end-to-end (so connectivity + auth are fine)
- `/v2/ai/conversations` returns empty — the assistant never even starts a conversation

This appears to be a Telnyx-side gap or undocumented requirement with anonymous WebRTC + AI Assistants. The dashboard's web-call test is currently usable only on the Vapi provider; the Telnyx provider works for code/abstraction purposes but the visible UX is blocked.

**Unblockers to try (in order of effort):**
1. Reach out to Telnyx support with the assistant_id and a sample failed call timestamp — they have access to internal SIP traces that the public API doesn't surface.
2. Test against Telnyx's official WebRTC demo at `https://webrtc.telnyx.com` using the same assistant_id and `supports_unauthenticated_web_calls`. If their demo also fails, the issue is purely assistant config. If their demo works, we have a code/SDP difference to chase.
3. Skip anonymous WebRTC for the dashboard — provision a real DID + telephony credential, and switch to JWT mode (already coded; just needs env vars). PSTN inbound and JWT-WebRTC are documented and have working examples.
4. Bypass the dashboard entirely for end-to-end test — when the DID is live, dial the Telnyx number from a regular phone. Webhooks + Custom LLM POSTs will hit the gateway normally; this exercises everything except the WebRTC SDK code path.

The provider abstraction, normalized webhook handling, opener service, integration secret wiring, and gateway-side code are all production-ready — only the anonymous-mode WebRTC path is blocked.

## 🔵 Nice-to-have / future

- [ ] **Schema-level retention** of `provider_recording_id` plus per-provider recording lifecycle (Telnyx recordings expire by default — check retention policy).
- [ ] **Multi-instance provider switching.** Today the dashboard's `ProviderSelector` writes a cookie; per-request gateway calls pass `?provider=`. The factory caches provider instances at the module level — safe with multiple gateway pods because cache is per-pod and config is stateless. No further work required unless we add runtime config to providers.
- [ ] **Bridge endpoint cleanup.** `web_call_bridge:{uuid}` keys have 300s TTL. If we want to clean them up on call.ended too, add a `redis.del` in `handleCallEnded`. Low priority — TTL handles it.
- [ ] **Test fixture for Telnyx end-of-call flow.** The integration tests cover the Vapi happy path. Add a parallel suite that signs Telnyx-shaped payloads with a test keypair and asserts `call.started → call.ended → recording.ready` write the right DB rows.
- [ ] **Per-call provider audit dashboard.** Surface `voice_provider` column in `/calls` list so we can spot-check distribution during canary.

---

## Diagnostic helpers currently live

These are dev-mode aids that should be removed or quieted before prod:

- `TELNYX_INSECURE_DEV=1` env var — bypasses Ed25519 verification + dumps headers/body of every webhook and LLM POST. See `telnyx-provider.ts::verifyWebhook` and the conditional `logger.warn` blocks in `webhook.ts` + `llm.ts`.
- `parseLlmEnvelope` checks five header names and four body field locations for `call_control_id`. Once we observe Telnyx's actual envelope in the wild, narrow this back to the canonical 1-2 paths — see `telnyx-provider.ts::parseLlmEnvelope`.
- `header_keys` logging on webhook-auth failure. Useful while debugging Telnyx header naming; remove once signature verification is solid.
