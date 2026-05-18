import Link from 'next/link';
import { CaretLeft } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { LiveTail } from '@/components/live-tail';
import { PageHeader } from '@/components/page-header';

export const dynamic = 'force-dynamic';

export default async function LiveTailPage({
  params,
}: {
  params: Promise<{ callId: string }>;
}) {
  const { callId } = await params;
  return (
    <>
      <PageHeader
        title="Live transcript"
        description={`Call ${callId}`}
        breadcrumbs={[
          { label: 'Overview', href: '/' },
          { label: 'Live', href: '/live' },
          { label: `${callId.slice(0, 8)}…` },
        ]}
        action={
          <Button asChild variant="ghost">
            <Link href="/live">
              <CaretLeft className="size-4" />
              Active calls
            </Link>
          </Button>
        }
      />
      <div className="p-6">
        <LiveTail callId={callId} />
      </div>
    </>
  );
}
