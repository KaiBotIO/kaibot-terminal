import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import { isDesktop } from '@/lib/utils';

interface AuthCheckProps {
  children: React.ReactNode;
}

export function AuthCheck({ children }: AuthCheckProps) {
  type AuthStatus = 'loading' | 'setup' | 'login' | 'authed';
  const [status, setStatus] = useState<AuthStatus>('loading');
  const location = useLocation();

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
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
        // catch a bad token).
        try {
          await api.get('/api/user/settings');
          next = 'authed';
        } catch (error: any) {
          // Token invalid or expired → drop it and send to login.
          localStorage.removeItem('auth_token');
          next = 'login';
        }
      }
    } catch (error: any) {
      console.error('Auth check failed:', error);
      next = 'login';
    } finally {
      setStatus(next);
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 border border-border bg-[hsl(var(--surface-container-low))] px-10 py-8">
          <div className="size-2 rounded-full bg-primary animate-pulse" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Connecting
          </p>
        </div>
      </div>
    );
  }

  // Desktop version should not have login/signup flows
  if (isDesktop()) {
    // On desktop, if we need setup, allow setup page
    if (location.pathname === '/setup') {
      if (status === 'setup') {
        return <>{children}</>;
      } else {
        // Admin account exists, go to main app
        return <Navigate to="/" replace />;
      }
    }
    
    // If needs setup and not on setup page, redirect to setup
    if (status === 'setup') {
      return <Navigate to="/setup" replace />;
    }
    
    // For desktop, skip login entirely and go to main app
    return <>{children}</>;
  }

  // Web version logic (original behavior)
  // If on setup page, only allow access if admin account doesn't exist
  if (location.pathname === '/setup') {
    if (status === 'setup') {
      return <>{children}</>;
    } else {
      // Admin account exists, redirect to login
      return <Navigate to="/login" replace />;
    }
  }

  // If on login page, always allow access
  if (location.pathname === '/login') {
    return <>{children}</>;
  }

  // If needs setup and not on setup page, redirect to setup
  if (status === 'setup') {
    return <Navigate to="/setup" replace />;
  }
  
  // If needs login and not on login page, redirect to login
  if (status === 'login') {
    return <Navigate to="/login" replace />;
  }

  // Otherwise, render children
  return <>{children}</>;
}