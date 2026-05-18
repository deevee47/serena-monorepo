'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChatView } from '@/components/chat-view';
import { CopyTranscriptButton } from '@/components/copy-transcript-button';
import { Transcript, type TranscriptTurn } from '@/components/transcript';
import { SCRUB_EVENT } from '@/components/call-scrubber';
import { cn } from '@/lib/utils';

interface ConversationTabsProps {
  turns: TranscriptTurn[];
  emptyHint?: string;
  /** Optional WhatsApp copy header (e.g. "Funded Friday call — John Doe — 17 May 2026"). */
  copyHeader?: string;
  /** When true the card becomes a flex column that fills its parent's
   *  height; only the chat / transcript body scrolls. Used by the cockpit
   *  layout where the conversation owns the right pane. */
  fillHeight?: boolean;
}

export function ConversationTabs({
  turns,
  emptyHint,
  copyHeader,
  fillHeight = false,
}: ConversationTabsProps) {
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // Listen for jump requests dispatched by the CallScrubber. Find the
  // matching turn row within OUR subtree (both Chat and Transcript tabs
  // tag their rows with data-turn-index) and scroll it into view, then
  // briefly highlight it. We try the currently-visible tab first; if it
  // can't be found there (e.g. the user is on Transcript but the row is
  // missing — shouldn't happen, but defensive) we fall back to any match.
  React.useEffect(() => {
    function onScrub(e: Event) {
      const detail = (e as CustomEvent<{ turnNumber?: number }>).detail;
      const target = detail?.turnNumber;
      if (target == null || !cardRef.current) return;

      // Prefer the visible tab — its row is the one the user will see scroll.
      const root = cardRef.current;
      const candidates = root.querySelectorAll<HTMLElement>(
        `[data-turn-index="${target}"]`,
      );
      const visible = Array.from(candidates).find(
        (el) => el.offsetParent !== null,
      );
      const el = visible ?? candidates[0];
      if (!el) return;

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('turn-row-pulse');
      window.setTimeout(() => el.classList.remove('turn-row-pulse'), 1600);
    }

    window.addEventListener(SCRUB_EVENT, onScrub);
    return () => window.removeEventListener(SCRUB_EVENT, onScrub);
  }, []);

  return (
    <Card
      ref={cardRef}
      className={cn(fillHeight && 'flex min-h-0 flex-1 flex-col')}
    >
      <Tabs
        defaultValue="chat"
        className={cn('w-full', fillHeight && 'flex min-h-0 flex-1 flex-col')}
      >
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Conversation ({turns.length})</CardTitle>
          <div className="flex items-center gap-2">
            <CopyTranscriptButton turns={turns} header={copyHeader} agentLabel="Maya" />
            <TabsList>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <Separator />
        <TabsContent
          value="chat"
          className={cn('m-0', fillHeight && 'flex min-h-0 flex-1 flex-col')}
        >
          <ChatView
            turns={turns}
            emptyHint={emptyHint ?? 'No messages.'}
            fill={fillHeight}
          />
        </TabsContent>
        <TabsContent
          value="transcript"
          className={cn('m-0', fillHeight && 'flex min-h-0 flex-1 flex-col')}
        >
          <Transcript
            turns={turns}
            emptyHint={emptyHint ?? 'No turns recorded.'}
            fill={fillHeight}
          />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
