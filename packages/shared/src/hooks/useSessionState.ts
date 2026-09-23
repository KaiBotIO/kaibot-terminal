import { useEffect, useState } from "react";

/**
 * useState whose value is persisted to sessionStorage under `key`, so it
 * survives unmount/remount — e.g. navigating into a detail route and back, or a
 * reload within the same tab. Pass `key: null` to disable persistence and
 * behave like a plain useState.
 *
 * sessionStorage (not localStorage) on purpose: this is working-session UI
 * state (sort/filter choices), not a long-term preference — it resets to the
 * default when the tab closes.
 */
export function useSessionState<T>(
  key: string | null,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (!key || typeof window === "undefined") return initial;
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (!key || typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota errors / disabled storage
    }
  }, [key, value]);

  return [value, setValue];
}
