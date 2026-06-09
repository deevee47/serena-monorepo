'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Broadcast,
  Microphone,
  Package,
  Phone,
  PhoneOutgoing,
  SquaresFour,
  Tag,
  Users,
} from '@phosphor-icons/react/dist/ssr';

import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

const CALL_NAV = [
  { href: '/', label: 'Telemetry', icon: SquaresFour },
  { href: '/live', label: 'Ongoing Calls', icon: Broadcast },
  { href: '/calls', label: 'Calls History', icon: Phone },
  { href: '/talk', label: 'Talk to agent', icon: Microphone },
  { href: '/trigger', label: 'Trigger Phone Call', icon: PhoneOutgoing },
];

const CONTENT_NAV = [
  { href: '/products', label: 'Products', icon: Package },
  { href: '/offers', label: 'Offers', icon: Tag },
  { href: '/customers', label: 'Customers', icon: Users },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-2">
          <span className="size-1.5 shrink-0 bg-serena-accent" />
          <span className="text-[13px] font-medium uppercase tracking-[0.28em] text-foreground/90 group-data-[collapsible=icon]:hidden">
            Serena
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Calls</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {CALL_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                      <Link href={item.href}>
                        <Icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Content</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {CONTENT_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                      <Link href={item.href}>
                        <Icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
