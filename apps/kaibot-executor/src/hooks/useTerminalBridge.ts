import { useCallback, useEffect, useRef } from 'react';
import {
  ExecutorHostBridge,
  toBridgeBots,
  toBridgeFills,
  toBridgePositions,
  type BridgeStatus,
} from '@kaibot/terminal-bridge';
import { ONLINE_TERMINAL_ORIGIN } from '@/lib/config';
import { bridgeApi } from '@/lib/terminal-bridge-api';

/**
 * Owns the executor-host side of the terminal bridge for the embedded /terminal
 * page. Returns a ref to attach to the <iframe>. Once the iframe loads and the
 * online terminal posts `ready`, the host pushes local positions/bots/status
 * snapshots on a timer and routes inbound deploy/arm/start-stop/take-over
 * commands to the executor LOCAL api.
 *
 * Fills/positions stay LOCAL — they are posted into the iframe for charting, never
 * sent to the server (carve-out: "nothing rolls back").
 */
export function useTerminalBridge(pollMs = 4000) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ExecutorHostBridge | null>(null);
  const readyRef = useRef(false);

  const pushSnapshot = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge || !readyRef.current) return;
    try {
      const [positions, fills, bots, halt] = await Promise.all([
        bridgeApi.positions().catch(() => []),
        bridgeApi.fills().catch(() => []),
        bridgeApi.bots().catch(() => []),
        bridgeApi.halt().catch(() => ({ halted: false })),
      ]);
      bridge.sendPositions(toBridgePositions(positions));
      bridge.sendFills(toBridgeFills(fills));
      bridge.sendBotList(toBridgeBots(bots));
      const status: BridgeStatus = {
        online: true,
        halted: Boolean(halt?.halted),
        connectedExchanges: 0,
      };
      bridge.sendStatus(status);
    } catch {
      // transient local-api hiccup — next tick retries
    }
  }, []);

  // Build the bridge once with handlers wired to the local api.
  useEffect(() => {
    const getTarget = () => iframeRef.current?.contentWindow ?? null;
    const bridge = new ExecutorHostBridge({
      // Lazy target: the iframe contentWindow only exists after mount/load.
      target: {
        postMessage: (message: unknown, targetOrigin: string) => {
          getTarget()?.postMessage(message, targetOrigin);
        },
      },
      terminalOrigin: ONLINE_TERMINAL_ORIGIN,
      handlers: {
        onReady: () => {
          readyRef.current = true;
          bridge.sendHello();
          void pushSnapshot();
        },
        onStartBot: (id) => bridgeApi.startBot(id).then(pushSnapshot),
        onArmBot: (id) => bridgeApi.startBot(id).then(pushSnapshot),
        onStopBot: (id) => bridgeApi.stopBot(id).then(pushSnapshot),
        onDeployBot: (msg) =>
          bridgeApi.deployBot(msg.bot).then(() => {
            void pushSnapshot();
          }),
        onDetachSignal: (id) => bridgeApi.detachBot(id).then(pushSnapshot),
        onTakeOver: ({ botId }) =>
          botId ? bridgeApi.detachBot(botId).then(pushSnapshot) : undefined,
        onReject: (reason, raw) => {
          if (reason !== 'origin-not-allowed') return;
          console.warn('[terminal-bridge] dropped message from', raw.origin);
        },
      },
    });
    bridgeRef.current = bridge;

    const onMessage = (ev: MessageEvent) => bridge.handleIncoming({ origin: ev.origin, data: ev.data });
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      bridgeRef.current = null;
      readyRef.current = false;
    };
  }, [pushSnapshot]);

  // Poll local state and push snapshots while the iframe is ready.
  useEffect(() => {
    const interval = setInterval(() => void pushSnapshot(), pollMs);
    return () => clearInterval(interval);
  }, [pushSnapshot, pollMs]);

  return { iframeRef, pushSnapshot };
}
