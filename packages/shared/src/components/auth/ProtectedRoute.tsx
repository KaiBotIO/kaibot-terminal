import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface ProtectedRouteProps {
  children: ReactNode;
  redirectPath?: string;
  isAuthenticated: boolean;
  isPending: boolean;
  isLoading: boolean;
}

export function ProtectedRoute({ 
  children, 
  redirectPath = '/login',
  isAuthenticated,
  isPending,
  isLoading
}: ProtectedRouteProps) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPending) {
      const currentPath = window.location.pathname;
      if (currentPath !== '/login' && currentPath !== '/') {
        document.cookie = `RedirectUrl=${currentPath}; path=/; max-age=600`;
      }
      
      navigate(redirectPath);
    }
  }, [isAuthenticated, isLoading, isPending, navigate, redirectPath]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="animate-spin rounded-full size-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex flex-col justify-center items-center h-screen p-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-4">Verification Pending</h1>
          <p className="mb-6">We've sent a verification link to your email. Please check your inbox and click the link to continue.</p>
          <div className="animate-pulse text-primary text-sm">Waiting for verification…</div>
        </div>
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : null;
}