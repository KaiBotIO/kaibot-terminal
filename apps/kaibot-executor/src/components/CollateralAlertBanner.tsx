import { Link } from "react-router-dom";
import { usePolledResource } from "@/hooks/usePolledResource";
import { collateralApi, type CollateralAlertView } from "@/lib/collateral-api";

// Hedge traps that are live right now (near the floor, fired, margin ratio).
// Pass `alerts` when the page already has them; otherwise it polls.
export function CollateralAlertBanner({ alerts, link = true }: { alerts?: CollateralAlertView[]; link?: boolean }) {
  const polled = usePolledResource(() => collateralApi.alerts(), { intervalMs: 15000, enabled: alerts === undefined });
  const list = alerts ?? polled.data?.alerts ?? [];
  if (list.length === 0) return null;
  return (
    <div role="alert" className="border-b border-destructive/40 bg-destructive/10">
      {list.map((a) => (
        <div
          key={`${a.floorId}-${a.trap}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-6 py-1.5 text-xs"
        >
          <span className={a.trap === "near" ? "font-medium text-[var(--kb-amber)]" : "font-medium text-destructive"}>
            {a.title}
          </span>
          <span className="text-foreground">{a.body}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {a.exchange} · {a.accountId}
          </span>
          {link && (
            <Link to="/collateral" className="ml-auto text-[11px] underline underline-offset-2">
              Collateral
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
