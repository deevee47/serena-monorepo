-- Add a user-settable display name to calls. Nullable: when null the dashboard
-- derives "{product} — {date}".
ALTER TABLE "calls" ADD COLUMN "name" TEXT;
