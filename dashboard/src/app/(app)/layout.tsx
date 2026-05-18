import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { isAuthed } from '@/lib/auth';

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  if (!(await isAuthed())) {
    redirect('/login');
  }
  const cookieStore = await cookies();
  // Persist sidebar open/closed across renders. shadcn writes this cookie
  // from the SidebarProvider when the user toggles via the trigger / shortcut.
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false';

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
