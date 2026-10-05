import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSetAtom } from 'jotai';
import { api } from '@/lib/api';
import { isDesktop } from '@/lib/utils';
import { sessionRoleAtom, type SessionRole } from '@/lib/atoms';

type AuthStatus = 'loading' | 'setup' | 'login' | 'authed';

interface AuthCheckProps {
  children: React.ReactNode;
}

// Setup/Login write to localStorage and then navigate() away, which only
// changes the route — it doesn't re-run AuthCheck's own status check. Without
// this, AuthCheck keeps rendering its stale 'setup'/'login' status and bounces
// the user straight back. Pages call refreshAuthStatus() right after storing
// the token so the new status is in place before they navigate.
const AuthRefreshContext = createContext<() => Promise<void>>(async () => {});

export function useAuthRefresh() {
  return useContext(AuthRefreshContext);
}

export function AuthCheck({ children }: AuthCheckProps) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const setSessionRole = useSetAtom(sessionRoleAtom);
  const location = useLocation();

  const checkAuthStatus = useCallback(async () => {
    let next: AuthStatus = 'login';
    try {
      // Check if we have a token first
      const token = localStorage.getItem('auth_token');

      if (!token) {
        // No token, check if admin account exists
        try {
          await api.get('/api/auth/me');
          // If we get here, admin exists but we're not authenticated
          next = 'login';
        } catch (error: any) {
          // 404 → no admin account exists yet; otherwise assume login
          next = error.message.includes('404') ? 'setup' : 'login';
        }
      } else {
        // We have a token — validate it against a protected route so an
        // invalid/expired token is rejected (auth/me is public and would not
        // catch a bad token). The same call tells us the role.
        try {
          const session = await api.get('/api/auth/session');
          setSessionRole(session?.role === 'viewer' ? 'viewer' : ('admin' satisfies SessionRole));
          next = 'authed';
        } catch (error: any) {
          // Token invalid or expired → drop it and send to login.
          localStorage.removeItem('auth_token');
          setSessionRole(null);
          next = 'login';
        }
      }
    } catch (error: any) {
      console.error('Auth check failed:', error);
      next = 'login';
    } finally {
      setStatus(next);
    }
  }, [setSessionRole]);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  let content: React.ReactNode;

  if (status === 'loading') {
    content = (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 border border-border bg-[hsl(var(--surface-container-low))] px-10 py-8">
          <div className="size-2 rounded-full bg-primary animate-pulse" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Connecting
          </p>
        </div>
      </div>
    );
  } else if (isDesktop()) {
    // Desktop version should not have login/signup flows
    if (location.pathname === '/setup') {
      // On desktop, if we need setup, allow setup page
      content = status === 'setup' ? <>{children}</> : <Navigate to="/" replace />;
    } else if (status === 'setup') {
      // If needs setup and not on setup page, redirect to setup
      content = <Navigate to="/setup" replace />;
    } else {
      // For desktop, skip login entirely and go to main app
      content = <>{children}</>;
    }
  } else {
    // Web version logic (original behavior)
    if (location.pathname === '/setup') {
      // If on setup page, only allow access if admin account doesn't exist
      content = status === 'setup' ? <>{children}</> : <Navigate to="/login" replace />;
    } else if (location.pathname === '/login') {
      // If on login page, always allow access
      content = <>{children}</>;
    } else if (status === 'setup') {
      // If needs setup and not on setup page, redirect to setup
      content = <Navigate to="/setup" replace />;
    } else if (status === 'login') {
      // If needs login and not on login page, redirect to login
      content = <Navigate to="/login" replace />;
    } else {
      content = <>{children}</>;
    }
  }

  return <AuthRefreshContext.Provider value={checkAuthStatus}>{content}</AuthRefreshContext.Provider>;
}
