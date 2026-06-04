import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Renders the voice platform a call ran on. Matches the existing OutcomeBadge
 * tone — small pill, no icon — so it slots into table rows + KPI strips
 * without changing surrounding rhythm.
 *
 * Accepts the raw `Call.voiceProvider` column (set by the gateway when the
 * session is created). Older rows from before the column existed pass `null`
 * and render as a muted "—" so we don't pretend to know.
 */
type Platform = 'vapi' | 'telnyx' | string | null | undefined;

interface PlatformBadgeProps {
  provider: Platform;
  className?: string;
}

export function PlatformBadge({ provider, className }: PlatformBadgeProps) {
  if (!provider) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)} aria-label="Platform unknown">
        —
      </span>
    );
  }
  const normalized = provider.toLowerCase();
  if (normalized === 'telnyx') {
    return (
      <Badge variant="info" className={cn('font-mono uppercase tracking-wider', className)}>
        Telnyx
      </Badge>
    );
  }
  if (normalized === 'vapi') {
    return (
      <Badge variant="ff" className={cn('font-mono uppercase tracking-wider', className)}>
        Vapi
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn('font-mono uppercase tracking-wider', className)}>
      {provider}
    </Badge>
  );
}
