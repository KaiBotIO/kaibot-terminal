import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Badge, Logo } from "@kaibot/shared";
import { Bell, LogOut, ExternalLink, Settings, User, KeyRound } from "@/lib/icons";
import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { Link } from "react-router-dom";
import { userAtom, activityEventsAtom, activityLastSeenAtom } from "@/lib/atoms";
import { isDesktop, cn, openExternalUrl } from "@/lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { useApiConnection } from "@/hooks/useApiConnection";
import { api } from "@/lib/api";
import { KAIBOT_APP_URL } from "@/lib/config";

export default function AppTopbar() {
  const user = useAtomValue(userAtom);
  const apiConnection = useApiConnection();
  const navigate = useNavigate();

  // Unread = backend events newer than the last Activity-page visit.
  const activityEvents = useAtomValue(activityEventsAtom);
  const activityLastSeen = useAtomValue(activityLastSeenAtom);
  const lastSeenMs = activityLastSeen ? Date.parse(activityLastSeen) : 0;
  const unreadCount = activityEvents.filter((e) => Date.parse(e.timestamp) > lastSeenMs).length;

  const handleLogout = async () => {
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      /* best effort — clear locally regardless */
    }
    localStorage.removeItem('auth_token');
    // Full reload so AuthCheck re-runs and routes to login/setup.
    window.location.href = isDesktop() ? '/' : '/login';
  };

  return (
    <header
      className={cn(
        "bg-background border-b border-border relative z-20",
        isDesktop() && "pt-7"
      )}
      data-tauri-drag-region
    >
      <div className="flex justify-between items-center gap-4 px-3 py-2" data-tauri-drag-region>
        {/* Logo → home */}
        <Link to="/" className="flex items-center gap-1.5" data-tauri-drag-region>
          <Logo size={16} />
          <span className="font-heading text-xs font-semibold text-foreground">KaiBot Terminal</span>
        </Link>

        <div className="flex items-center gap-0.5" data-tauri-drag-region={undefined}>
          {/* API Connection Indicator */}
          {!apiConnection.isLoading && !apiConnection.isConfigured && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => navigate('/settings')}
              title="No API connection to KaiBot Studio, click to configure"
              className="relative"
            >
              <KeyRound className="size-3.5 text-[var(--kb-red)]" />
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-[var(--kb-red)] animate-pulse" />
            </Button>
          )}

          {/* Notifications */}
          <Button variant="ghost" size="icon-sm" className="relative" asChild>
            <Link to="/activity">
              <Bell className="size-3.5" />
              {unreadCount > 0 && (
                <Badge className="absolute -top-0.5 -right-0.5 h-3.5 min-w-3.5 px-0.5 flex items-center justify-center text-[9px]" variant="destructive">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Badge>
              )}
            </Link>
          </Button>

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 h-7">
                <div className="size-5 border border-border flex items-center justify-center">
                  {user?.name ? (
                    <span className="text-[10px] font-medium">{user.name.charAt(0)}</span>
                  ) : (
                    <User className="size-3" />
                  )}
                </div>
                <span className="hidden sm:inline text-xs font-medium text-foreground">{user?.name || ''}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {user?.name ? (
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
              ) : (
                <div className="px-2 py-1.5">
                  <p className="text-sm text-muted-foreground">No API key configured</p>
                </div>
              )}
              <DropdownMenuItem className="cursor-pointer" onClick={() => openExternalUrl(KAIBOT_APP_URL)}>
                <ExternalLink className="size-4 mr-2" />
                My Account & Bots
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" asChild>
                <Link to="/settings">
                  <Settings className="size-4 mr-2" />
                  Settings
                </Link>
              </DropdownMenuItem>
              {!isDesktop() && (
                <>
                  <DropdownMenuItem className="cursor-pointer" asChild>
                    <div className="flex items-center justify-between w-full">
                      <span className="text-sm">Theme</span>
                      <ThemeToggle />
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer text-destructive" onClick={handleLogout}>
                    <LogOut className="size-4 mr-2" />
                    Logout
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
