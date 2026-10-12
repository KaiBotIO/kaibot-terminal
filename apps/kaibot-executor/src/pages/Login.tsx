import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Input,
  Label,
  Button,
  Toaster,
} from '@kaibot/shared';
import { toast } from 'sonner';
import { Lock, AlertCircle } from '@/lib/icons';
import { api } from '@/lib/api';
import { isDesktop } from '@/lib/utils';
import { AuthPanel } from '@/components/AuthPanel';

// Validation schema
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const labelClassName = 'font-mono text-[10px] uppercase tracking-widest text-muted-foreground';

export default function Login() {
  const [loading, setLoading] = useState(false);
  // The Toaster lives in the authed AppLayout, so a toast on the login route
  // renders nothing. Surface failures inline as well so a bad login isn't silent.
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showResetHelp, setShowResetHelp] = useState(false);

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  const handleLogin = form.handleSubmit(async (data) => {
    setLoading(true);
    setLoginError(null);
    try {
      const response = await api.post('/api/auth/login', {
        username: data.username,
        password: data.password,
      });

      if (response.token) {
        localStorage.setItem('auth_token', response.token);
        toast.success('Signed in');
        window.location.href = '/';
      } else if (response.error) {
        setLoginError(response.error);
        toast.error(response.error);
      }
    } catch (error: any) {
      const message = error.message?.includes('401')
        ? 'Invalid username or password'
        : 'Login failed';
      setLoginError(message);
      toast.error(message);
      console.error('Login error:', error);
    } finally {
      setLoading(false);
    }
  });

  return (
    <AuthPanel
      role="Sign in to continue"
      dragRegion={isDesktop()}
      footer={
        <Button type="submit" form="login-form" size="default" disabled={loading} className="w-full h-9 text-xs">
          <Lock className="size-3.5 mr-1.5" />
          {loading ? 'Signing in…' : 'Sign In'}
        </Button>
      }
    >
      <form id="login-form" onSubmit={handleLogin} className="space-y-4">
        {loginError && (
          <div
            role="alert"
            className="flex items-center gap-1.5 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive font-mono"
          >
            <AlertCircle className="size-3.5 shrink-0" />
            {loginError}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="username" className={labelClassName}>
            Username
          </Label>
          <Input
            id="username"
            placeholder="Enter your username"
            {...form.register('username')}
            disabled={loading}
            className="h-9 text-sm"
          />
          {form.formState.errors.username && (
            <div className="flex items-center gap-1.5 text-xs text-destructive font-mono">
              <AlertCircle className="size-3" />
              {form.formState.errors.username.message}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className={labelClassName}>
            Password
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="Enter your password"
            {...form.register('password')}
            disabled={loading}
            className="h-9 text-sm"
          />
          {form.formState.errors.password && (
            <div className="flex items-center gap-1.5 text-xs text-destructive font-mono">
              <AlertCircle className="size-3" />
              {form.formState.errors.password.message}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowResetHelp((v) => !v)}
            className="font-mono text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Forgot password?
          </button>
          {showResetHelp && (
            <p className="rounded-sm border border-border/60 bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
              This account only exists on this machine, so there's no email reset. Stop the
              executor, run{" "}
              <code className="font-mono text-foreground">kaibot-executor reset-admin</code> on it
              (add <code className="font-mono">--profile</code> or{" "}
              <code className="font-mono">--data-dir</code> if you use one), then start it again
              and create a new account. Exchange keys and history stay in place.
            </p>
          )}
        </div>
      </form>
      <Toaster />
    </AuthPanel>
  );
}
