import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Sparkle } from '@phosphor-icons/react/dist/ssr';

interface Props {
  summary: string | null;
  fallbackUsed?: boolean;
  pending: boolean;
}

export function InsightSummaryCard({ summary, fallbackUsed, pending }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Sparkle className="size-3.5" weight="fill" />
          Summary
        </CardTitle>
        {fallbackUsed ? (
          <Badge variant="outline" className="text-[10px]">
            heuristic
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : summary ? (
          <p className="text-sm leading-relaxed text-foreground">{summary}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No summary available.</p>
        )}
      </CardContent>
    </Card>
  );
}
