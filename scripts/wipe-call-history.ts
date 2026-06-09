/**
 * Wipe ALL call history from Postgres.
 *
 * Deletes every row in the call-history tables — CallTurn, CallInsight, and
 * Call — in FK-safe order (children first) inside a single transaction. It
 * does NOT touch customers, products, orders, offers, or anything else; only
 * the call log the dashboard's /calls page reads.
 *
 * Live Redis sessions (`session:*`) are left alone — they self-expire on their
 * 2h TTL and aren't part of the persisted history.
 *
 * Usage:
 *   bun scripts/wipe-call-history.ts          # refuses — prints a hint
 *   bun scripts/wipe-call-history.ts --yes     # actually deletes
 *
 * Bun auto-loads .env, so DATABASE_URL is picked up automatically.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Show which database we're about to wipe, without leaking the password. */
function describeTarget(): string {
  const raw = process.env['DATABASE_URL'];
  if (!raw) return '(DATABASE_URL not set)';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const confirmed =
    process.argv.slice(2).includes('--yes') || process.argv.slice(2).includes('-y');

  if (!confirmed) {
    console.error('✗ Refusing to wipe call history without confirmation.');
    console.error(`  Target DB: ${describeTarget()}`);
    console.error('  This deletes ALL calls, turns, and insights — re-run with --yes:');
    console.error('    bun scripts/wipe-call-history.ts --yes');
    process.exitCode = 1;
    return;
  }

  console.log(`Wiping call history from: ${describeTarget()}`);

  // Children before parents — CallTurn and CallInsight both reference
  // Call.callId and the relations aren't ON DELETE CASCADE. One transaction so
  // a mid-way failure rolls the whole thing back rather than leaving orphans.
  const [turns, insights, calls] = await prisma.$transaction([
    prisma.callTurn.deleteMany({}),
    prisma.callInsight.deleteMany({}),
    prisma.call.deleteMany({}),
  ]);

  console.log(
    `✓ Deleted ${turns.count} turns, ${insights.count} insights, ${calls.count} calls.`,
  );
}

main()
  .catch((err) => {
    console.error('✗ Wipe failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
