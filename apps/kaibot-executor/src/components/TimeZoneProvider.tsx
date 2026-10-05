import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { setDisplayTimeZone } from "@kaibot/shared";
import { displayTimeZoneAtom } from "@/lib/atoms";

/**
 * Applies the saved display zone to the shared formatters, so every page reads
 * the same clock. Renders nothing: the formatters are module-level, not
 * context, which is what keeps the call sites unchanged.
 */
export function TimeZoneProvider({ children }: { children: React.ReactNode }) {
  const zone = useAtomValue(displayTimeZoneAtom);
  useEffect(() => {
    setDisplayTimeZone(zone || null);
  }, [zone]);
  return <>{children}</>;
}
