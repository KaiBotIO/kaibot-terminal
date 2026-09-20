import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

export type NotificationEventType =
  | 'signal_received'
  | 'order_filled'
  | 'order_rejected'
  | 'order_pending'
  | 'connection_lost'
  | 'connection_restored'
  | 'executor_conflict'
  | 'update_available'
  | 'update_required'
  | 'basis_guard_rejected'
  | 'basis_guard_inconclusive'
  | 'entry_deferred'
  | 'entry_resumed'
  | 'entry_deferred_dropped'
  | 'synthetic_rebalanced'
  | 'trail_stop_failed'
  | 'manager_close'
  | 'hedge_opened'
  | 'hedge_closed'
  | 'hedge_orphaned'
  | 'hedge_failed'
  | 'synthetic_armed_minted'
  | 'synthetic_armed_closed'
  | 'synthetic_armed_failed'
  | 'roll_required'
  | 'position_rolled'
  | 'roll_failed'
  | 'error';

export interface NotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface NotificationBusAttachOptions {
  path?: string;
  // Upgrade-time auth gate. Return false to refuse the WebSocket with a 401 —
  // required in web/Docker mode, where an unauthenticated socket would leak
  // live trading activity to anyone who can reach the port. Omitted = allow
  // (desktop loopback sidecar, which trusts the local caller like its REST
  // layer does).
  authorize?: (req: IncomingMessage) => boolean;
}

/**
 * NotificationBus broadcasts structured notification events to any attached
 * WebSocket clients (the Tauri frontend). It is deliberately tiny — the
 * rate-limiting, debouncing and actual OS notifications are handled in the
 * frontend helper so the user can toggle per-event-type from Settings.
 */
export class NotificationBus extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server, options: NotificationBusAttachOptions | string = {}) {
    // Back-compat: a bare string is the path (legacy signature).
    const opts = typeof options === 'string' ? { path: options } : options;
    const path = opts.path ?? '/api/ws/notifications';
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== path) return;

        // Same auth the REST layer enforces, applied at upgrade time: no valid
        // session → no socket, so trading activity never streams to
        // unauthenticated clients.
        if (opts.authorize && !opts.authorize(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.clients.add(ws);
          ws.on('close', () => this.clients.delete(ws));
          ws.on('error', () => this.clients.delete(ws));
          // greet so the frontend knows it's ready
          try {
            ws.send(
              JSON.stringify({
                type: 'hello',
                timestamp: new Date().toISOString(),
              }),
            );
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore bad upgrade */
      }
    });
  }

  publish(event: Omit<NotificationEvent, 'timestamp'>) {
    const payload: NotificationEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.emit('notification', payload);
    const serialized = JSON.stringify({ type: 'notification', event: payload });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(serialized);
        } catch {
          /* ignore per-client send errors */
        }
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close() {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export const notificationBus = new NotificationBus();
