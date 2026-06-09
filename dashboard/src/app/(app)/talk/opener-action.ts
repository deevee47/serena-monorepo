'use server';

import { isAuthed } from '@/lib/auth';
import { bindWebCallContext, generateOpener, type CallMode } from '@/lib/gateway';

export async function fetchOpenerAction(input: {
  mode: CallMode;
  product_id?: string | null;
  language?: 'en' | 'hi';
}): Promise<string | null> {
  if (!(await isAuthed())) return null;
  return generateOpener(input);
}

/**
 * Bind a freshly-started web call to the product the caller selected. Runs
 * after `vapi.start` returns the Vapi call id. The gateway stores this so its
 * lazily-created session resolves the right product instead of the default —
 * see `bindWebCallContext` in `@/lib/gateway` and `/calls/web-context`.
 */
export async function bindWebCallContextAction(input: {
  call_id: string;
  product_id?: string | null;
}): Promise<boolean> {
  if (!(await isAuthed())) return false;
  return bindWebCallContext(input);
}
