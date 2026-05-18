import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Warning, CheckCircle } from '@phosphor-icons/react/dist/ssr';
import { cn } from '@/lib/utils';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ServiceConcern {
  category: string;
  severity: Severity;
  description: string;
  evidence_turn_id?: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  pricing_dissatisfaction: 'Pricing dissatisfaction',
  technical_issue: 'Technical issue',
  service_issue: 'Service issue',
  sales_rep_issue: 'Sales rep issue',
  delivery_delay: 'Delivery delay',
  order_modification: 'Order modification',
  promotion_request: 'Promotion request',
  unresolved_followup: 'Unresolved follow-up',
  escalation_risk: 'Escalation risk',
  kyc_friction: 'KYC friction',
  payout_concern: 'Payout concern',
  no_service_issues: 'No operational issues',
};

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const SEVERITY_DOT: Record<Severity, string> = {
  CRITICAL: 'bg-rose-600',
  HIGH: 'bg-rose-500',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-slate-400',
};

interface Props {
  concerns: ServiceConcern[];
  pending: boolean;
}

export function InsightConcernsCard({ concerns, pending }: Props) {
  const sorted = [...concerns].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const onlyClean = sorted.length === 1 && sorted[0].category === 'no_service_issues';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Warning className="size-3.5" weight="fill" />
          Service Concerns
        </CardTitle>
      </CardHeader>
      <CardContent>
        {pending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : onlyClean ? (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="size-4" weight="fill" />
            No operational issues detected on this call.
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No concerns recorded.</p>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map((c, i) => (
              <li
                key={`${c.category}-${i}`}
                className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-2.5"
              >
                <span
                  className={cn('mt-1 size-2 shrink-0 rounded-full', SEVERITY_DOT[c.severity])}
                  aria-label={c.severity}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {CATEGORY_LABELS[c.category] ?? c.category}
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {c.severity}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.description}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
