import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  TrendUp,
  TrendDown,
  ArrowsHorizontal,
  Smiley,
} from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';

type Overall = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'MIXED';
type Trend = 'improving' | 'degrading' | 'stable';

interface Props {
  overall: Overall | null;
  emotions: string[];
  trend: Trend | null;
  confidence: number | null;
  pending: boolean;
}

const OVERALL_STYLES: Record<Overall, { label: string; bar: string; chip: 'success' | 'destructive' | 'warning' | 'secondary' }> = {
  POSITIVE: { label: 'Positive', bar: 'from-emerald-400 to-emerald-500', chip: 'success' },
  NEGATIVE: { label: 'Negative', bar: 'from-rose-500 to-red-500', chip: 'destructive' },
  MIXED: { label: 'Mixed', bar: 'from-amber-400 to-orange-500', chip: 'warning' },
  NEUTRAL: { label: 'Neutral', bar: 'from-slate-300 to-slate-400', chip: 'secondary' },
};

function TrendIcon({ trend }: { trend: Trend }) {
  if (trend === 'improving') {
    return <TrendUp className="size-4 text-emerald-600 dark:text-emerald-400" />;
  }
  if (trend === 'degrading') {
    return <TrendDown className="size-4 text-rose-600 dark:text-rose-400" />;
  }
  return <ArrowsHorizontal className="size-4 text-muted-foreground" />;
}

export function InsightSentimentCard({
  overall,
  emotions,
  trend,
  confidence,
  pending,
}: Props) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Smiley className="size-3.5" weight="fill" />
          Sentiment
        </CardTitle>
        {!pending && trend ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground capitalize">
            <TrendIcon trend={trend} />
            {trend}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="space-y-3">
            <Skeleton className="h-2 w-full" />
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
          </div>
        ) : overall ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{OVERALL_STYLES[overall].label}</span>
                {confidence !== null ? (
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(confidence * 100)}% confidence
                  </span>
                ) : null}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full bg-gradient-to-r transition-all',
                    OVERALL_STYLES[overall].bar,
                  )}
                  style={{ width: `${Math.max(8, (confidence ?? 0.5) * 100)}%` }}
                />
              </div>
            </div>
            {emotions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {emotions.map((e) => (
                  <Badge key={e} variant="outline" className="capitalize">
                    {e}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sentiment data yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
