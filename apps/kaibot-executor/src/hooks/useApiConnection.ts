import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export interface ApiConnectionState {
  isLoading: boolean;
  isConfigured: boolean;
  apiUrl: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useApiConnection(pollMs = 10_000): ApiConnectionState {
  const [isLoading, setIsLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/user/settings");
      if (!res.ok) {
        setIsConfigured(false);
        setError(`settings unavailable (${res.status})`);
        return;
      }
      const data = await res.json();
      const apiConfig = data?.settings?.apiConfig;
      const key: string | undefined = apiConfig?.apiKey;
      setIsConfigured(!!key && key.trim().length > 0);
      setApiUrl(apiConfig?.apiUrl ?? null);
      setError(null);
    } catch (err: any) {
      setIsConfigured(false);
      setError(err?.message ?? "unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    if (pollMs > 0) {
      const interval = setInterval(refresh, pollMs);
      return () => clearInterval(interval);
    }
  }, [refresh, pollMs]);

  return { isLoading, isConfigured, apiUrl, error, refresh };
}
