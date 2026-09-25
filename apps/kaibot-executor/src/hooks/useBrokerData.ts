import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { apiFetch } from "@/lib/api";
import { usePolledResource } from "@/hooks/usePolledResource";
import {
  exchangeSessionsAtom,
  balancesAtom,
  positionsAtom,
  type Balance,
  type Position,
} from "@/lib/atoms";
import { accountQuery, sessionKey } from "@/lib/connection";

interface BrokerSnapshot {
  sessions: any[];
  positions: Position[];
  balances: Map<string, Balance[]>;
}

async function fetchBrokerSnapshot(): Promise<BrokerSnapshot> {
  const sessionsResponse = await apiFetch(`/api/exchanges/v2/sessions`, {
    headers: { "x-user-id": "default" },
  });

  if (!sessionsResponse.ok) throw new Error("Failed to fetch sessions");

  const sessions = await sessionsResponse.json();
  const allPositions: Position[] = [];
  const balances = new Map<string, Balance[]>();

  await Promise.all(
    sessions.reduce((acc: Promise<void>[], session: any) => {
      if (session.status !== "connected") return acc;
      acc.push(
        (async () => {
          try {
            // Per CONNECTION: `?account=` scopes the call to this session's
            // connection, so two Deribit accounts never read as one.
            const q = accountQuery(session);
            const [positionsRes, balancesRes] = await Promise.all([
              apiFetch(`/api/exchanges/v2/positions/${session.exchangeName}${q}`, {
                headers: { "x-user-id": "default" },
              }),
              apiFetch(`/api/exchanges/v2/balances/${session.exchangeName}${q}`, {
                headers: { "x-user-id": "default" },
              }),
            ]);
            if (positionsRes.ok) {
              const positions: Position[] = await positionsRes.json();
              // tag each position with the exchange it came from so the
              // table can show a source column (Position has no exchange field)
              allPositions.push(
                ...positions.map((p) => ({
                  ...p,
                  exchange: session.exchangeName,
                  accountKey: session.accountKey ?? null,
                })),
              );
            }
            if (balancesRes.ok) {
              balances.set(sessionKey(session), await balancesRes.json());
            }
          } catch (error) {
            console.error(
              `Failed to fetch data for ${session.exchangeName}:`,
              error,
            );
          }
        })(),
      );
      return acc;
    }, []),
  );

  return { sessions, positions: allPositions, balances };
}

/**
 * Loads the user's REAL broker state (exchange sessions, live positions,
 * balances) into the shared jotai atoms — the same load the Dashboard does,
 * extracted so the Positions and Portfolio pages reuse one loader instead of
 * each re-implementing the sessions → positions/balances fan-out.
 *
 * Writes to the same atoms the Dashboard reads, so any mounted page stays in
 * sync. Polls every `pollMs` and exposes `refresh` for a manual reload.
 * A failed poll keeps the last good atoms and flags `isStale`; `error` is
 * only set when the very first load fails.
 */
export function useBrokerData(pollMs = 5000) {
  const setExchangeSessions = useSetAtom(exchangeSessionsAtom);
  const setBalances = useSetAtom(balancesAtom);
  const setPositions = useSetAtom(positionsAtom);

  const { data, error, isStale, lastUpdated, isLoading, refresh } =
    usePolledResource(fetchBrokerSnapshot, { intervalMs: pollMs });

  useEffect(() => {
    if (!data) return;
    setExchangeSessions(data.sessions);
    setPositions(data.positions);
    setBalances(data.balances);
  }, [data, setExchangeSessions, setPositions, setBalances]);

  return { isLoading, isStale, error, lastUpdated, refresh };
}
