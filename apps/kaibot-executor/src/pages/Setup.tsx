import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Input,
  Label,
  Button,
  TERMS_VERSION,
} from '@kaibot/shared';
import { toast } from 'sonner';
import { Key, Lock, AlertCircle } from '@/lib/icons';
import { api } from '@/lib/api';
import { interpretConnectionTest } from '@/lib/connection-test';
import { isDesktop } from '@/lib/utils';
import { AuthPanel } from '@/components/AuthPanel';
import { KAIBOT_API_URL, TERMS_URL, RISK_URL } from '@/lib/config';

// Validation schemas
const passwordSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

const apiKeySchema = z.object({
  apiKey: z.string()
    .min(1, 'API key is required')
    .regex(/^kb_[a-zA-Z0-9]{64}$/, 'Invalid API key format. Should start with kb_ followed by 64 characters'),
});

type PasswordFormData = z.infer<typeof passwordSchema>;
type ApiKeyFormData = z.infer<typeof apiKeySchema>;

const labelClassName = 'font-mono text-[10px] uppercase tracking-widest text-muted-foreground';

export default function Setup() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'password' | 'apikey'>('password');
  const [loading, setLoading] = useState(false);
  // First-run legal acceptance (R5): the executor is where real orders happen,
  // so its setup carries its own ToS/risk acknowledgment, recorded locally.
  const [legalAccepted, setLegalAccepted] = useState(false);

  // Password form
  const passwordForm = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      username: '',
      password: '',
      confirmPassword: '',
    },
  });

  // API key form
  const apiKeyForm = useForm<ApiKeyFormData>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: {
      apiKey: '',
    },
  });

  const handlePasswordSetup = passwordForm.handleSubmit(async (data) => {
    setLoading(true);
    try {
      const response = await api.post('/api/auth/setup', {
        username: data.username,
        password: data.password
      });

      if (response.success) {
        toast.success('Account created');

        // Store the token if provided (which means we're also logged in)
        if (response.token) {
          localStorage.setItem('auth_token', response.token);
        }

        // Durable local record of the first-run legal acceptance. Best-effort:
        // the blocking checkbox is the gate; this persists when it happened.
        try {
          await api.put('/api/user/settings', {
            settings: {
              legalAcceptance: {
                termsVersion: TERMS_VERSION,
                acceptedAt: new Date().toISOString(),
              },
            },
          });
        } catch {
          // non-fatal: settings endpoint requires the fresh token; ignore
        }

        // For web version, proceed to API key setup
        // For desktop, we can skip API key as it's optional
        if (!isDesktop()) {
          setStep('apikey');
        } else {
          navigate('/');
        }
      } else if (response.error) {
        toast.error(response.error);
      }
    } catch (error: any) {
      if (error.message.includes('400')) {
        toast.error('An account already exists. Please login instead.');
      } else {
        toast.error('Failed to create account');
      }
      console.error('Setup error:', error);
    } finally {
      setLoading(false);
    }
  });

  const handleApiKeySetup = apiKeyForm.handleSubmit(async (data) => {
    setLoading(true);
    try {
      // Test the connection first
      const testResponse = await api.post('/api/test-connection', {
        apiUrl: KAIBOT_API_URL,
        apiKey: data.apiKey
      });

      // A 200 with { success: false } used to fall through silently — surface it.
      const outcome = interpretConnectionTest(testResponse);
      if (!outcome.ok) {
        toast.error(outcome.message);
        return;
      }

      // Save the API configuration
      await api.put('/api/user/settings', {
        settings: {
          apiConfig: {
            apiUrl: KAIBOT_API_URL,
            apiKey: data.apiKey,
            autoConnect: true
          }
        }
      });

      toast.success('Setup complete');
      navigate('/');
    } catch (error) {
      toast.error('Failed to connect to API');
    } finally {
      setLoading(false);
    }
  });

  const skipApiKey = () => {
    toast('You can configure API settings later in Settings');
    // Force a page reload to trigger AuthCheck again
    window.location.href = '/';
  };

  const desktop = isDesktop();
  // Desktop never reaches the api-key step (account creation navigates straight
  // to '/'), so its stepper is single-step; web shows the full 2-step flow.
  const steps = desktop
    ? [{ index: '1', label: 'Account', active: true }]
    : [
        { index: '1', label: 'Account', active: step === 'password' },
        { index: '2', label: 'API Key', active: step === 'apikey' },
      ];

  return (
    <AuthPanel
      role={step === 'password' ? 'Create your account' : 'Connect to your KaiBot API'}
      dragRegion={desktop}
      steps={steps}
      footer={
        step === 'password' ? (
          <Button
            type="submit"
            form="setup-password-form"
            className="w-full h-9 text-xs"
            disabled={loading || !legalAccepted}
          >
            <Lock className="size-3.5 mr-1.5" />
            {loading ? 'Creating Account…' : 'Create Account'}
          </Button>
        ) : (
          <>
            <Button type="submit" form="setup-apikey-form" className="w-full h-9 text-xs" disabled={loading}>
              <Key className="size-3.5 mr-1.5" />
              {loading ? 'Connecting…' : 'Connect to API'}
            </Button>
            <Button
              type="button"
              className="w-full h-9 text-xs"
              variant="outline"
              onClick={skipApiKey}
              disabled={loading}
            >
              Skip for now
            </Button>
          </>
        )
      }
    >
      {step === 'password' ? (
        <>
          <PasswordSetupForm onSubmit={handlePasswordSetup} form={passwordForm} loading={loading} />
          <label className="mt-3 flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={legalAccepted}
              onChange={(e) => setLegalAccepted(e.target.checked)}
              disabled={loading}
              className="mt-0.5 size-4 accent-primary"
            />
            <span className="text-xs text-muted-foreground leading-relaxed">
              I agree to the{' '}
              <a href={TERMS_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Terms of Service
              </a>{' '}
              and have read the{' '}
              <a href={RISK_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Risk Disclosure
              </a>
              . This executor is free, open-source software (AGPL-3.0) that
              places real orders on my exchange account with my own API keys.
              It comes as is, without warranty, support or uptime commitment;
              keeping it running and watching my positions is my job, and every
              trade it makes is my responsibility.
            </span>
          </label>
        </>
      ) : (
        <ApiKeySetupForm onSubmit={handleApiKeySetup} form={apiKeyForm} loading={loading} />
      )}
    </AuthPanel>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-destructive font-mono">
      <AlertCircle className="size-3" />
      {message}
    </div>
  );
}

function PasswordSetupForm({
  onSubmit,
  form,
  loading,
}: {
  onSubmit: (e?: React.BaseSyntheticEvent) => void;
  form: ReturnType<typeof useForm<PasswordFormData>>;
  loading: boolean;
}) {
  return (
    <form id="setup-password-form" onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="username" className={labelClassName}>Username</Label>
        <Input
          id="username"
          placeholder="admin"
          {...form.register('username')}
          disabled={loading}
          className="h-9 text-sm"
        />
        <FieldError message={form.formState.errors.username?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password" className={labelClassName}>Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="At least 8 characters"
          {...form.register('password')}
          disabled={loading}
          className="h-9 text-sm"
        />
        <FieldError message={form.formState.errors.password?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword" className={labelClassName}>Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          placeholder="Re-enter your password"
          {...form.register('confirmPassword')}
          disabled={loading}
          className="h-9 text-sm"
        />
        <FieldError message={form.formState.errors.confirmPassword?.message} />
      </div>
    </form>
  );
}

function ApiKeySetupForm({
  onSubmit,
  form,
  loading,
}: {
  onSubmit: (e?: React.BaseSyntheticEvent) => void;
  form: ReturnType<typeof useForm<ApiKeyFormData>>;
  loading: boolean;
}) {
  return (
    <form id="setup-apikey-form" onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="apiKey" className={labelClassName}>API Key</Label>
        <Input
          id="apiKey"
          type="password"
          placeholder="kb_xxxxxxxxxx…"
          {...form.register('apiKey')}
          disabled={loading}
          className="h-9 text-sm"
        />
        <FieldError message={form.formState.errors.apiKey?.message} />
      </div>
    </form>
  );
}
