import { apiFetch } from '@/lib/api';

// Shared Studio-pairing state. Every surface that asks "is an API key
// configured" (topbar plug, dashboard, subscription wizard) reads this one
// store, so saving a key in Settings updates all of them without a remount.
export interface ApiConnectionSnapshot {
  isLoading: boolean;
  isConfigured: boolean;
  apiUrl: string | null;
  error: string | null;
}

let snapshot: ApiConnectionSnapshot = {
  isLoading: true,
  isConfigured: false,
  apiUrl: null,
  error: null,
};

const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

export function getApiConnectionSnapshot(): ApiConnectionSnapshot {
  return snapshot;
}

export function subscribeApiConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: ApiConnectionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

// Optimistic update for the surface that just wrote the key: the pairing state
// flips before the round trip, so Connect is usable the moment a save resolves.
export function setApiConnectionConfigured(apiKey: string | undefined, apiUrl?: string | null) {
  publish({
    isLoading: false,
    isConfigured: !!apiKey && apiKey.trim().length > 0,
    apiUrl: apiUrl ?? snapshot.apiUrl,
    error: null,
  });
}

export function refreshApiConnection(): Promise<void> {
  // Concurrent callers (several mounted consumers, a save + a poll) share one
  // request instead of racing each other's results into the store.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await apiFetch('/api/user/settings');
      if (!res.ok) {
        publish({ ...snapshot, isLoading: false, isConfigured: false, error: `settings unavailable (${res.status})` });
        return;
      }
      const data = await res.json();
      const apiConfig = data?.settings?.apiConfig;
      const key: string | undefined = apiConfig?.apiKey;
      publish({
        isLoading: false,
        isConfigured: !!key && key.trim().length > 0,
        apiUrl: apiConfig?.apiUrl ?? null,
        error: null,
      });
    } catch (err: any) {
      publish({ ...snapshot, isLoading: false, isConfigured: false, error: err?.message ?? 'unknown error' });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// Tests only: drop the module-level state between cases.
export function resetApiConnectionStore() {
  snapshot = { isLoading: true, isConfigured: false, apiUrl: null, error: null };
  inFlight = null;
}
