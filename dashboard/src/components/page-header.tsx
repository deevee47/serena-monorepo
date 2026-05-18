import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { LiveCallsIndicator } from '@/components/live-calls-indicator';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export interface BreadcrumbItemDef {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  breadcrumbs?: BreadcrumbItemDef[];
  className?: string;
}

export function PageHeader({
  title,
  description,
  action,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  const hasCrumbs = breadcrumbs && breadcrumbs.length > 0;
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75',
        className,
      )}
    >
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-6" />
      <div className="min-w-0 flex-1">
        {hasCrumbs ? (
          <Breadcrumb>
            <BreadcrumbList className="text-xs">
              {breadcrumbs!.map((crumb, i) => {
                const isLast = i === breadcrumbs!.length - 1;
                return (
                  <Fragment key={`${crumb.label}-${i}`}>
                    <BreadcrumbItem>
                      {isLast || !crumb.href ? (
                        <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link href={crumb.href}>{crumb.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                    {!isLast ? <BreadcrumbSeparator /> : null}
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        ) : null}
        <h1 className="truncate text-lg font-semibold tracking-tight leading-tight">{title}</h1>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex items-center">{action}</div> : null}
      <LiveCallsIndicator />
      <ThemeToggle />
    </header>
  );
}
