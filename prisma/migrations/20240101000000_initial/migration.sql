-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('CONVERTED', 'DROPPED', 'NO_ANSWER', 'ERROR');

-- CreateEnum
CREATE TYPE "Speaker" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL');

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "phone_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "outcome" "CallOutcome",
    "final_score" INTEGER,
    "discount_given" INTEGER NOT NULL DEFAULT 0,
    "stage_reached" TEXT,
    "product_id" TEXT,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_turns" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "turn_number" INTEGER NOT NULL,
    "speaker" "Speaker" NOT NULL,
    "utterance" TEXT NOT NULL,
    "objection_type" TEXT,
    "sentiment" "Sentiment",
    "score_before" INTEGER NOT NULL,
    "score_after" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "discount_offered" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(65,30) NOT NULL,
    "category" TEXT,
    "tags" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "embedding_synced" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_config" (
    "key" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scoring_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_call_id_key" ON "calls"("call_id");

-- CreateIndex
CREATE INDEX "call_turns_call_id_idx" ON "call_turns"("call_id");

-- CreateIndex
CREATE INDEX "call_turns_call_id_turn_number_idx" ON "call_turns"("call_id", "turn_number");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- AddForeignKey
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("call_id") ON DELETE RESTRICT ON UPDATE CASCADE;

