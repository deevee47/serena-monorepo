'use client';

import * as React from 'react';
import { CaretRight } from '@phosphor-icons/react/dist/ssr';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface RailSectionProps {
  title: string;
  /** Small chip on the right of the header (e.g. count, status). */
  badge?: React.ReactNode;
  /** Defaults to closed; pass true to ship the section expanded. */
  defaultOpen?: boolean;
  /** Optional rendered slot in the header row, e.g. a regen button. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** Collapsible "rail section" — used in the call cockpit's left column.
 *  Renders as a flat panel with a thin caret-toggle header and a content
 *  area that animates open/closed via the radix collapsible. Several stack
 *  vertically in the rail to keep the meta column dense without forcing
 *  the user to scroll past unused detail. */
export function RailSection({
  title,
  badge,
  defaultOpen = false,
  actions,
  children,
}: RailSectionProps) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/rail border border-border/80 bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-transparent px-3 py-2 group-data-[state=open]/rail:border-border/60">
        <CollapsibleTrigger
          className={cn(
            'flex flex-1 items-center gap-2 text-left font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <CaretRight
            className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/rail:rotate-90"
            weight="bold"
          />
          <span className="text-foreground/80">{title}</span>
          {badge != null ? (
            <span className="ml-1 text-muted-foreground">{badge}</span>
          ) : null}
        </CollapsibleTrigger>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
      <CollapsibleContent className="data-[state=closed]:animate-none data-[state=open]:animate-none">
        <div className="px-3 py-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
