-- Replace tactic-pipeline columns on call_turns with tool-call attribution
-- columns used by the converse (function-calling LLM) pipeline.

-- DropIndex
DROP INDEX "call_turns_tactic_idx";

-- AlterTable
ALTER TABLE "call_turns" DROP COLUMN "pipeline",
DROP COLUMN "tactic",
DROP COLUMN "tactic_reasoning",
ADD COLUMN     "tool_args" JSONB,
ADD COLUMN     "tool_called" TEXT;

-- CreateIndex
CREATE INDEX "call_turns_tool_called_idx" ON "call_turns"("tool_called");
