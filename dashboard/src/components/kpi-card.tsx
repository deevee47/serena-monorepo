import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: string | number;
  hint?: string;
  accent?: 'default' | 'ff';
}

export function KpiCard({ label, value, hint, accent = 'default' }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs uppercase tracking-wide">{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <CardTitle
          className={cn('text-3xl tabular-nums', accent === 'ff' && 'text-ff-orange')}
        >
          {value}
        </CardTitle>
        {hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
