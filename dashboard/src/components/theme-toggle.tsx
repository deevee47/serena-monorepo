'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, Desktop } from '@phosphor-icons/react/dist/ssr';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          <Sun className="size-4 scale-100 transition-transform dark:scale-0" />
          <Moon className="absolute size-4 scale-0 transition-transform dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun />
          Light
          {theme === 'light' ? <span className="ml-auto text-xs text-muted-foreground">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon />
          Dark
          {theme === 'dark' ? <span className="ml-auto text-xs text-muted-foreground">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Desktop />
          System
          {theme === 'system' || !theme ? (
            <span className="ml-auto text-xs text-muted-foreground">●</span>
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
