import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContextType } from '../types/auth';

interface UseAuthOptions {
  onUserChange?: (user: { name: string; roles: string[] } | null) => void;
}

export function useAuth(authClient: any, options?: UseAuthOptions): AuthContextType {
  // Async network request flag (magic-link + dev fetch), not a UI state transition —
  // useState is correct here; useTransition would not track the awaited work.
  const [isPending, setIsPending] = useState(false);
  const navigate = useNavigate();

  const session = authClient.useSession();
  const sessionData = session.data;
  const isLoading = session.isPending;

  const isAuthenticated = !!sessionData?.user;

  useEffect(() => {
    if (sessionData?.user) {
      options?.onUserChange?.({
        name: sessionData.user.name || sessionData.user.email,
        roles: sessionData.user.roles || ['trader'],
      });
    } else if (!isLoading && !sessionData) {
      options?.onUserChange?.(null);
    }
  }, [sessionData, isLoading]);

  const login = useCallback(async (email: string, name?: string) => {
    try {
      setIsPending(true);
      const { error } = await authClient.signIn.magicLink({
        email,
        ...(name ? { name } : {}),
        callbackURL: `${window.location.origin}/dashboard`,
      });

      if (error) {
        setIsPending(false);
        return { success: false, error: error.message || 'Login failed' };
      }

      // In dev mode, fetch the magic link from the dev endpoint
      let magicLink: string | undefined;
      try {
        const res = await fetch(`/api/auth/dev/magic-link?email=${encodeURIComponent(email)}`);
        const data = await res.json();
        if (data.url) {
          // Replace the host with the current origin so the link works from any device
          try {
            const linkUrl = new URL(data.url);
            linkUrl.host = window.location.host;
            linkUrl.protocol = window.location.protocol;
            magicLink = linkUrl.toString();
          } catch {
            magicLink = data.url;
          }
        }
      } catch {
        // Dev endpoint not available (production), no problem
      }

      setIsPending(false);
      return { success: true, magicLink };
    } catch (error) {
      setIsPending(false);
      return { success: false, error: 'Login request failed' };
    }
  }, [authClient]);

  const logout = useCallback(async () => {
    try {
      await authClient.signOut();

      // Force the session atom to null immediately. better-auth's reactive
      // session refetch is delayed (10ms setTimeout + network), causing the
      // login page to read stale "authenticated" state and bounce back to
      // /dashboard before the refetch settles.
      const sessionAtom = (authClient as any).$store?.atoms?.session;
      if (sessionAtom?.get && sessionAtom?.set) {
        const current = sessionAtom.get();
        sessionAtom.set({ ...current, data: null, error: null, isPending: false, isRefetching: false });
      }

      options?.onUserChange?.(null);
      navigate('/login');
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Logout failed' };
    }
  }, [authClient, navigate]);

  return {
    isAuthenticated,
    isPending,
    isLoading,
    login,
    logout,
    user: sessionData?.user
      ? {
          name: sessionData.user.name || sessionData.user.email,
          roles: sessionData.user.roles || ['trader'],
        }
      : null,
  };
}
