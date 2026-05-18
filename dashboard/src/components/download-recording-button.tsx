'use client';

import { useCallback, useState } from 'react';
import { CircleNotch, DownloadSimple, WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';

interface DownloadRecordingButtonProps {
  callId: string;
  filenameBase?: string;
}

function inferExtension(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    if (dot >= 0 && dot >= path.length - 6) return path.slice(dot);
  } catch {
    // fall through
  }
  return '.wav';
}

export function DownloadRecordingButton({
  callId,
  filenameBase,
}: DownloadRecordingButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/recording`, {
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as
        | { recording_url?: string | null; stereo_recording_url?: string | null; error?: string }
        | null;
      if (!res.ok) {
        if (res.status === 404) {
          setError('Recording not ready yet — Vapi usually publishes it within a minute.');
        } else {
          setError(body?.error ?? `Lookup failed (${res.status})`);
        }
        return;
      }
      const url = body?.stereo_recording_url ?? body?.recording_url;
      if (!url) {
        setError('No recording URL returned.');
        return;
      }
      const ext = inferExtension(url);
      const base = filenameBase ?? `call-${callId.slice(0, 8)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}${ext}`;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(false);
    }
  }, [callId, filenameBase]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={download} disabled={loading}>
        {loading ? (
          <CircleNotch className="size-4 animate-spin" />
        ) : (
          <DownloadSimple className="size-4" />
        )}
        {loading ? 'Fetching…' : 'Download recording'}
      </Button>
      {error ? (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <WarningCircle className="size-3" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
