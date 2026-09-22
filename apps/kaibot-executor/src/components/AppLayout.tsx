import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Toaster } from '@kaibot/shared';
import { toast } from 'sonner';
import { CommandMenu } from './CommandMenu';
import AppTopbar from './AppTopbar';
import AppSidebar from './AppSidebar';
import { UpdateBanner } from './UpdateBanner';
import { useAtomValue } from 'jotai';
import { effectiveBrandVariantAtom } from '@/lib/atoms';
import { cn } from '@/lib/utils';

export default function AppLayout() {
  const brandVariant = useAtomValue(effectiveBrandVariantAtom);
  const navigate = useNavigate();

  // Return from an OAuth authorize redirect. The backend callback bounces the
  // browser to /?exchange_connected=<name> (or ?exchange_error=<msg>) at the app
  // root. Surface the outcome and strip the param so a reload can't re-fire it;
  // the Exchanges page polls sessions, so the new connection appears on its own.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('exchange_connected');
    const failed = params.get('exchange_error');
    if (!connected && !failed) return;

    if (connected) {
      toast.success(`Connected to ${connected}`);
      navigate('/exchanges', { replace: true });
    } else if (failed) {
      toast.error(`Connection failed: ${failed}`);
      navigate('/exchanges', { replace: true });
    }
  }, [navigate]);

  return (
    <div className={cn("flex flex-col h-screen", brandVariant === 'kaibot' && "theme-kaibot")}>
      <AppTopbar />
      <UpdateBanner />

      <div className="flex flex-1 min-h-0">
        <AppSidebar />
        <main className="flex-1 min-h-0 overflow-y-auto bg-[hsl(var(--background))]">
          <Outlet />
        </main>
      </div>

      <CommandMenu />
      <Toaster />
    </div>
  );
}
