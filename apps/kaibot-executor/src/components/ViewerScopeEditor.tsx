import { useEffect, useState } from 'react';
import { Button, Checkbox, Label } from '@kaibot/shared';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';

// Which connections/accounts one viewer may see. Contract:
// node-backend/src/routes/users.ts (account-options, PUT /:id/scope).

export interface AccountGrant {
  exchange: string;
  kind: 'connection' | 'account';
  ref: string;
}

interface AccountOption {
  exchange: string;
  label: string;
  status: string;
  accounts: Array<{ accountId: string; name: string | null }>;
}

const grantKey = (g: AccountGrant) => `${g.exchange}|${g.kind}|${g.ref}`;

export function ViewerScopeEditor({
  userId,
  username,
  initial,
  onSaved,
  onClose,
}: {
  userId: number;
  username: string;
  initial: AccountGrant[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<AccountOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => new Map(initial.map((g) => [grantKey(g), g])));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/auth/users/account-options');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { options: AccountOption[] };
        if (!cancelled) setOptions(body.options);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isOn = (g: AccountGrant) => selected.has(grantKey(g));
  const toggle = (g: AccountGrant, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(grantKey(g), g);
      else next.delete(grantKey(g));
      return next;
    });

  // Grants that point at a connection or account not connected right now stay
  // in the list; they show under their own heading so they can be removed.
  const known = new Set<string>();
  for (const o of options ?? []) {
    known.add(grantKey({ exchange: o.exchange, kind: 'connection', ref: o.label }));
    for (const a of o.accounts) known.add(grantKey({ exchange: o.exchange, kind: 'account', ref: a.accountId }));
  }
  const orphans = [...selected.values()].filter((g) => options && !known.has(grantKey(g)));

  const save = async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/auth/users/${userId}/scope`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grants: [...selected.values()] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      toast.success(`Accounts for ${username} saved`);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border/60 px-6 py-3">
      <div className="mb-2 text-[11px] text-muted-foreground">
        {username} sees only what is ticked. New connections stay hidden until you tick them.
      </div>
      {error && (
        <div className="py-1 text-xs text-[var(--kb-red)]" role="alert">
          {error}
        </div>
      )}
      {!options && !error && <div className="py-1 text-xs text-muted-foreground">Loading connections…</div>}
      <div className="flex flex-col gap-3">
        {(options ?? []).map((o) => {
          const conn: AccountGrant = { exchange: o.exchange, kind: 'connection', ref: o.label };
          const connOn = isOn(conn);
          const connId = `scope-${userId}-${o.exchange}-${o.label}`;
          return (
            <div key={`${o.exchange}:${o.label}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Checkbox id={connId} checked={connOn} onCheckedChange={(v) => toggle(conn, v === true)} />
                <Label htmlFor={connId} className="font-mono text-[12px]">
                  {o.exchange} · {o.label}
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  {connOn ? 'whole connection' : o.status !== 'connected' ? o.status : ''}
                </span>
              </div>
              {o.accounts.length > 0 && (
                <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
                  {o.accounts.map((a) => {
                    const acc: AccountGrant = { exchange: o.exchange, kind: 'account', ref: a.accountId };
                    const accId = `${connId}-${a.accountId}`;
                    return (
                      <div key={a.accountId} className="flex items-center gap-1.5">
                        <Checkbox
                          id={accId}
                          disabled={connOn}
                          checked={connOn || isOn(acc)}
                          onCheckedChange={(v) => toggle(acc, v === true)}
                        />
                        <Label htmlFor={accId} className="font-mono text-[11px]">
                          {a.accountId}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {orphans.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-muted-foreground">Not connected right now</div>
            {orphans.map((g) => {
              const id = `scope-${userId}-orphan-${grantKey(g)}`;
              return (
                <div key={grantKey(g)} className="flex items-center gap-2">
                  <Checkbox id={id} checked onCheckedChange={(v) => toggle(g, v === true)} />
                  <Label htmlFor={id} className="font-mono text-[11px]">
                    {g.exchange} · {g.ref}
                  </Label>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" className="h-7 text-[11px]" disabled={busy || !options} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
