'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { isAuthed } from '@/lib/auth';

const MAX_NAME_LEN = 80;

/**
 * Rename a call. Trimmed and capped at 80 chars; empty/whitespace stores null
 * so the row reverts to the derived "{product} — {date}" default.
 */
export async function renameCallAction(
  callId: string,
  name: string,
): Promise<{ ok: boolean }> {
  if (!(await isAuthed())) return { ok: false };
  const trimmed = name.trim().slice(0, MAX_NAME_LEN);
  try {
    await prisma.call.update({
      where: { callId },
      data: { name: trimmed.length > 0 ? trimmed : null },
    });
  } catch {
    return { ok: false };
  }
  revalidatePath('/calls');
  revalidatePath(`/calls/${callId}`);
  return { ok: true };
}
