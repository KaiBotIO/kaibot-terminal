import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Label, Section, SettingRow, Badge, useConfirm } from '@kaibot/shared';
import { toast } from 'sonner';
import { KeyRound, Trash2, Plus } from '@/lib/icons';
import { apiFetch } from '@/lib/api';

// Admin-only: viewer accounts that can open this executor and read the book.
// Role rules live in node-backend/src/auth/roles.ts.

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  created_at: string;
  last_login: string | null;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    /* no JSON body */
  }
  return fallback;
}

export function UsersSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/users');
      if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`));
      const body = (await res.json()) as { users: UserRow[] };
      setUsers(body.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        toast.error(await readError(res, 'Could not create the account'));
        return;
      }
      toast.success(`Viewer ${username.trim()} created`);
      setUsername('');
      setPassword('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user: UserRow) => {
    const ok = await confirm({
      title: `Delete ${user.username}?`,
      description: 'Their sessions end immediately.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;
    const res = await apiFetch(`/api/auth/users/${user.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(await readError(res, 'Could not delete the account'));
      return;
    }
    toast.success(`${user.username} deleted`);
    await load();
  };

  const submitReset = async () => {
    if (!resetting) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/auth/users/${resetting.id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPassword }),
      });
      if (!res.ok) {
        toast.error(await readError(res, 'Could not reset the password'));
        return;
      }
      toast.success(`Password for ${resetting.username} reset`);
      setResetting(null);
      setResetPassword('');
    } finally {
      setBusy(false);
    }
  };

  const viewers = (users ?? []).filter((u) => u.role === 'viewer');
  const canCreate = username.trim().length >= 3 && password.length >= 8 && !busy;

  return (
    <>
      <Section label="Viewer accounts" flush noBorder>
        <div className="px-6 py-2 text-xs text-muted-foreground">
          A viewer has its own password and sees positions, fills, orders, signals and analytics. It cannot change anything.
        </div>
        {error && (
          <div className="px-6 py-2 text-xs text-[var(--kb-red)]" role="alert">
            {error}
          </div>
        )}
        {users && viewers.length === 0 && !error && (
          <div className="px-6 py-3 text-xs text-muted-foreground">No viewer accounts yet.</div>
        )}
        {viewers.map((user) => (
          <SettingRow
            key={user.id}
            label={
              <span className="flex items-center gap-2 text-[13px]">
                <span className="font-mono">{user.username}</span>
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  viewer
                </Badge>
              </span>
            }
            description={user.last_login ? `Last sign-in ${new Date(user.last_login).toLocaleString()}` : 'Never signed in'}
            control={
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    setResetting(user);
                    setResetPassword('');
                  }}
                >
                  <KeyRound className="size-3 mr-1" />
                  Reset password
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${user.username}`}
                  className="text-destructive"
                  onClick={() => void remove(user)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            }
          />
        ))}
        {resetting && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-border/60 px-6 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitReset();
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="viewer-reset-password" className="text-[11px] text-muted-foreground">
                New password for {resetting.username}
              </Label>
              <Input
                id="viewer-reset-password"
                type="password"
                autoComplete="new-password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                className="h-7 w-56 text-xs"
              />
            </div>
            <Button type="submit" size="sm" className="h-7 text-[11px]" disabled={resetPassword.length < 8 || busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setResetting(null)}>
              Cancel
            </Button>
          </form>
        )}
      </Section>

      <Section label="New viewer" flush noBorder>
        <form
          className="flex flex-wrap items-end gap-2 px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) void create();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="viewer-username" className="text-[11px] text-muted-foreground">
              Username
            </Label>
            <Input
              id="viewer-username"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-7 w-44 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="viewer-password" className="text-[11px] text-muted-foreground">
              Password (8+ characters)
            </Label>
            <Input
              id="viewer-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-7 w-56 text-xs"
            />
          </div>
          <Button type="submit" size="sm" className="h-7 text-[11px]" disabled={!canCreate}>
            <Plus className="size-3 mr-1" />
            Create viewer
          </Button>
        </form>
      </Section>
      {confirmDialog}
    </>
  );
}
