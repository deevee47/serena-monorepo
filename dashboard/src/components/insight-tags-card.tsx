import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tag } from '@phosphor-icons/react/dist/ssr';

type Tone = 'positive' | 'neutral' | 'warning' | 'danger' | 'info';

export interface InsightTag {
  key: string;
  label: string;
  tone: Tone;
  confidence: number;
}

const TONE_TO_VARIANT: Record<Tone, 'success' | 'secondary' | 'warning' | 'destructive' | 'info'> = {
  positive: 'success',
  neutral: 'secondary',
  warning: 'warning',
  danger: 'destructive',
  info: 'info',
};

interface Props {
  tags: InsightTag[];
  pending: boolean;
}

export function InsightTagsCard({ tags, pending }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Tag className="size-3.5" weight="fill" />
          Tag Response
        </CardTitle>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="flex flex-wrap gap-1.5">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        ) : tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tags assigned.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Badge
                key={t.key}
                variant={TONE_TO_VARIANT[t.tone] ?? 'secondary'}
                title={`${Math.round(t.confidence * 100)}% confidence`}
              >
                {t.label}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
