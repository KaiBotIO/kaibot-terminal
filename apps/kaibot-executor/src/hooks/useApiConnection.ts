import { useEffect, useSyncExternalStore } from "react";
import {
  getApiConnectionSnapshot,
  refreshApiConnection,
  subscribeApiConnection,
  type ApiConnectionSnapshot,
} from "@/lib/api-connection-store";

export interface ApiConnectionState extends ApiConnectionSnapshot {
  refresh: () => Promise<void>;
}

export function useApiConnection(pollMs = 10_000): ApiConnectionState {
  const snapshot = useSyncExternalStore(subscribeApiConnection, getApiConnectionSnapshot, getApiConnectionSnapshot);

  useEffect(() => {
    void refreshApiConnection();
    if (pollMs > 0) {
      const interval = setInterval(() => void refreshApiConnection(), pollMs);
      return () => clearInterval(interval);
    }
  }, [pollMs]);

  return { ...snapshot, refresh: refreshApiConnection };
}
