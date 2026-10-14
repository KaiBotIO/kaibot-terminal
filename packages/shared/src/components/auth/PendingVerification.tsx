import { useEffect, useState } from 'react';
import { Button } from '../ui/button';

const RESEND_COOLDOWN_SECONDS = 30;

interface PendingVerificationProps {
  email?: string;
  onResendLink?: () => Promise<void>;
  onUseDifferentEmail?: () => void;
  devMagicLink?: string;
}

export function PendingVerification({ email, onResendLink, onUseDifferentEmail, devMagicLink }: PendingVerificationProps) {
  const [isResending, setIsResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown > 0]);

  const handleResend = async () => {
    if (!onResendLink || cooldown > 0) return;
    setIsResending(true);
    setResendSuccess(false);
    try {
      await onResendLink();
      setResendSuccess(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-6 text-center">
      <div className="bg-primary/10 p-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="size-8 text-primary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
      </div>

      <h2 className="font-heading text-xl font-semibold tracking-tight">Check your inbox</h2>

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          We sent a magic link to{' '}
          <span className="font-mono text-primary">{email || 'your email address'}</span>
        </p>

        <p className="text-xs text-muted-foreground">
          The link expires in 10 minutes.
        </p>

        {devMagicLink ? (
          <a href={devMagicLink} className="block font-mono text-xs text-muted-foreground hover:text-foreground underline break-all">
            {devMagicLink}
          </a>
        ) : (
          <div className="animate-pulse">
            <div className="h-px w-24 bg-primary/20 mx-auto"></div>
          </div>
        )}
      </div>

      {onResendLink && (
        <div className="pt-2">
          <Button
            variant="outline"
            onClick={handleResend}
            disabled={isResending || cooldown > 0}
            className="font-mono text-xs uppercase tracking-wider"
          >
            {isResending
              ? 'Sending...'
              : cooldown > 0
                ? `Resend in ${cooldown}s`
                : 'Resend link'}
          </Button>

          {resendSuccess && (
            <p className="mt-2 text-xs text-[var(--kb-green)]">
              Link sent.
            </p>
          )}
        </div>
      )}

      <div className="w-full pt-4 mt-4">
        {onUseDifferentEmail ? (
          <button
            type="button"
            onClick={onUseDifferentEmail}
            className="font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline uppercase tracking-wider"
          >
            Use a different email
          </button>
        ) : (
          <a
            href="/login"
            className="font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline uppercase tracking-wider"
          >
            Use a different email
          </a>
        )}
      </div>
    </div>
  );
}
