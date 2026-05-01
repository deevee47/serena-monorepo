-- AlterTable
ALTER TABLE "call_turns" ADD COLUMN     "objection_subtype" TEXT,
ADD COLUMN     "pipeline" TEXT,
ADD COLUMN     "tactic" TEXT,
ADD COLUMN     "tactic_reasoning" TEXT;

-- CreateIndex
CREATE INDEX "call_turns_tactic_idx" ON "call_turns"("tactic");
