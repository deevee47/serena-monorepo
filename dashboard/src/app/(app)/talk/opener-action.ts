'use server';

import { isAuthed } from '@/lib/auth';
import { generateOpener, type CallMode } from '@/lib/gateway';

export async function fetchOpenerAction(input: {
  mode: CallMode;
  product_id?: string | null;
}): Promise<string | null> {
  if (!(await isAuthed())) return null;
  return generateOpener(input);
}
