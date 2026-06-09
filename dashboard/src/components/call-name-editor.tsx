'use client';

import { useRef, useState, useTransition } from 'react';
import { renameCallAction } from '@/app/(app)/calls/actions';
import { cn } from '@/lib/utils';

interface CallNameEditorProps {
  callId: string;
  /** Stored custom name, or null when the call was never renamed. */
  name: string | null;
  /** Derived "{product} — {date}" shown when there's no custom name. */
  defaultName: string;
  variant?: 'cell' | 'heading';
}

/**
 * Inline-editable call name. Shows the custom name when set, otherwise the
 * derived default (as real, editable text). Saving an empty value or the
 * unchanged default stores null, so the row falls back to the default again.
 * Used in the calls list (variant="cell") and on the call detail header
 * (variant="heading").
 */
export function CallNameEditor({
  callId,
  name,
  defaultName,
  variant = 'cell',
}: CallNameEditorProps) {
  const [value, setValue] = useState(name ?? defaultName);
  const lastSaved = useRef(name ?? defaultName);
  const [isPending, startTransition] = useTransition();

  function commit() {
    const trimmed = value.trim();
    // Empty or the unchanged default → no custom name (store null).
    const toStore = trimmed === '' || trimmed === defaultName ? '' : trimmed;
    const display = toStore === '' ? defaultName : toStore;
    setValue(display);
    if (display === lastSaved.current) return; // nothing changed
    lastSaved.current = display;
    startTransition(() => {
      void renameCallAction(callId, toStore);
    });
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(lastSaved.current);
          e.currentTarget.blur();
        }
      }}
      maxLength={80}
      spellCheck={false}
      aria-label="Call name"
      title="Click to rename"
      className={cn(
        'w-full min-w-0 truncate rounded border border-transparent bg-transparent outline-none',
        'transition-colors hover:border-border focus:border-ring focus:bg-background',
        variant === 'heading'
          ? 'px-2 py-1 text-lg font-semibold tracking-tight'
          : 'px-1.5 py-1 text-sm',
        isPending && 'opacity-60',
      )}
    />
  );
}
