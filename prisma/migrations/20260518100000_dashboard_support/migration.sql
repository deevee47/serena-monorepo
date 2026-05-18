-- CreateEnum
CREATE TYPE "OverallSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "calls"
    ADD COLUMN "recording_url" TEXT,
    ADD COLUMN "stereo_recording_url" TEXT;

-- AlterTable
ALTER TABLE "call_turns"
    ADD COLUMN "observations_called" JSONB;

-- CreateTable
CREATE TABLE "call_insights" (
    "call_id" TEXT NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL DEFAULT '',
    "overall_sentiment" "OverallSentiment" NOT NULL DEFAULT 'NEUTRAL',
    "emotions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentiment_trend" TEXT NOT NULL DEFAULT 'stable',
    "sentiment_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "service_concerns" JSONB NOT NULL DEFAULT '[]',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "model_used" TEXT,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_insights_pkey" PRIMARY KEY ("call_id")
);

-- CreateIndex
CREATE INDEX "call_insights_status_idx" ON "call_insights"("status");

-- AddForeignKey
ALTER TABLE "call_insights" ADD CONSTRAINT "call_insights_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("call_id") ON DELETE RESTRICT ON UPDATE CASCADE;
