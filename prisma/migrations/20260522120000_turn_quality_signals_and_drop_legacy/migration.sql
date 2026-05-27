-- Turn-quality signals on call_turns
--
--   push_attempt           — explicit 1..5 counter rendered into the
--                            ADAPTIVE_BEHAVIOR block of the next prompt so the
--                            LLM no longer has to infer the persistence stage
--                            from history. Null on USER turns + on AGENT turns
--                            that were a FAST_TRACK confirmation.
--
--   response_latency_ms    — pre-response latency on USER turns (ms between
--                            the previous AGENT TTS finishing and the user
--                            starting to speak). High = considering, very low
--                            = visceral reaction. Null when the gateway
--                            couldn't measure it (first turn, missing webhook
--                            timestamps).
--
--   observation_latencies_ms — jsonb array of per-observation tool-call latencies
--                              on AGENT turns. Used by the thinking-filler
--                              trimmer to suppress dead-air openers when the
--                              tool round-trip is fast enough that the filler
--                              would arrive after the result.
ALTER TABLE "call_turns"
    ADD COLUMN "push_attempt"               INTEGER,
    ADD COLUMN "response_latency_ms"        INTEGER,
    ADD COLUMN "observation_latencies_ms"   JSONB;

-- Drop legacy score/stage columns. The converse pipeline replaced the
-- rules-engine + tactics + stage machine with a single LLM call per turn;
-- these columns have been written as placeholder zeros for weeks and aren't
-- read by anything that ships data to a customer.
ALTER TABLE "call_turns"
    DROP COLUMN "score_before",
    DROP COLUMN "score_after",
    DROP COLUMN "stage";

ALTER TABLE "calls"
    DROP COLUMN "final_score",
    DROP COLUMN "stage_reached";
