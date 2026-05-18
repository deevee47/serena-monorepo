import { Badge } from '@/components/ui/badge';

export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) {
    return <Badge variant="outline">In flight</Badge>;
  }
  switch (outcome) {
    case 'CONVERTED':
      return <Badge variant="success">Converted</Badge>;
    case 'DROPPED':
      return <Badge variant="secondary">Dropped</Badge>;
    case 'NO_ANSWER':
      return <Badge variant="warning">No answer</Badge>;
    case 'ERROR':
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="outline">{outcome}</Badge>;
  }
}
