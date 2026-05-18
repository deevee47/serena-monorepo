'use client';

import { useCallback, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import type { TranscriptTurn } from '@/components/transcript';

interface CopyTranscriptButtonProps {
  turns: TranscriptTurn[];
  /** Optional header prepended to the copied text (e.g. customer / plan / date). */
  header?: string;
  /** Label shown in front of agent lines. WhatsApp wraps it in *bold*. */
  agentLabel?: string;
  /** Label shown in front of user lines. */
  callerLabel?: string;
}

function fmtArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

function formatForWhatsApp(
  turns: TranscriptTurn[],
  agentLabel: string,
  callerLabel: string,
  header?: string,
): string {
  const blocks: string[] = [];
  if (header) blocks.push(`*${header}*`);

  for (const t of turns) {
    const text = t.utterance.trim();
    const annotations: string[] = [];
    for (const obs of t.observations ?? []) {
      annotations.push(`tool: ${obs.name}${obs.args ? ` ${fmtArgs(obs.args)}` : ''}`);
    }
    if (t.toolCalled) {
      annotations.push(`tool: ${t.toolCalled}${t.toolArgs ? ` ${fmtArgs(t.toolArgs)}` : ''}`);
    }
    if (t.objectionType) {
      annotations.push(`objection: ${t.objectionType.replaceAll('_', ' ')}`);
    }
    if (!text && annotations.length === 0) continue;

    const speaker = t.speaker === 'AGENT' ? agentLabel : callerLabel;
    const lines: string[] = [];
    lines.push(`*${speaker}:* ${text}`);
    for (const a of annotations) lines.push(`_↳ ${a}_`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyTranscriptButton({
  turns,
  header,
  agentLabel = 'Agent',
  callerLabel = 'Caller',
}: CopyTranscriptButtonProps) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const copy = useCallback(async () => {
    const text = formatForWhatsApp(turns, agentLabel, callerLabel, header);
    if (!text) return;
    const ok = await writeClipboard(text);
    if (ok) {
      setCopied(true);
      setError(false);
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      setError(true);
      window.setTimeout(() => setError(false), 1800);
    }
  }, [turns, agentLabel, callerLabel, header]);

  const empty = turns.every((t) => t.utterance.trim().length === 0 && !t.toolCalled);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={copy}
      disabled={empty}
      title="Copy conversation as WhatsApp-formatted text"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : error ? 'Failed' : 'Copy'}
    </Button>
  );
}
