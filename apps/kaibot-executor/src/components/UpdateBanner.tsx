import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { updateInfoAtom } from '@/lib/atoms';
import { isUpdaterAvailable, installUpdateIfSafe } from '@/lib/updater';

// Slim banner shown above the app content when a newer executor is available.
// Soft by default (a nudge); the blocking variant appears when the API refused
// the connection because this version is below the hard floor. On desktop it
// offers an in-place update that refuses to relaunch while trades are open.
export function UpdateBanner() {
  const info = useAtomValue(updateInfoAtom);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!info) return null;

  const blocking = info.required === true;

  const onUpdate = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await installUpdateIfSafe();
    setBusy(false);
    if (outcome.status === 'blocked' || outcome.status === 'error') {
      setMessage(outcome.reason);
    } else if (outcome.status === 'no-update') {
      setMessage('Already up to date.');
    }
    // 'installed' relaunches the app, so nothing to show.
  };

  return (
    <div
      role="status"
      className={
        blocking
          ? 'flex flex-wrap items-center justify-center gap-2 border-b border-destructive/40 bg-destructive/15 px-4 py-1.5 text-xs text-destructive'
          : 'flex flex-wrap items-center justify-center gap-2 border-b border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/10 px-4 py-1.5 text-xs text-[hsl(var(--foreground))]'
      }
    >
      <span className="font-medium">{blocking ? 'Update required' : 'Update available'}</span>
      <span className="text-muted-foreground">
        {message
          ? message
          : blocking
            ? `v${info.current} can no longer connect. Install v${info.latestVersion} to continue.`
            : `You're on v${info.current}; v${info.latestVersion} is out.`}
      </span>
      {isUpdaterAvailable() && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={busy}
          className="rounded border border-current/30 px-2 py-0.5 font-medium hover:bg-current/10 disabled:opacity-50"
        >
          {busy ? 'Updating…' : 'Update now'}
        </button>
      )}
    </div>
  );
}
