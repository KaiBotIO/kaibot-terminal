import { describe, expect, it, mock } from 'bun:test';
import { ExecutorHostBridge, routeTerminalMessage } from '../host.js';
import { buildExecutorMessage, buildTerminalMessage } from '../serde.js';

const TERMINAL_ORIGIN = 'https://terminal.kaibot.app';

function makeTarget() {
  const posts: Array<{ message: unknown; targetOrigin: string }> = [];
  return {
    posts,
    target: { postMessage: (message: unknown, targetOrigin: string) => posts.push({ message, targetOrigin }) },
  };
}

describe('routeTerminalMessage', () => {
  it('dispatches each command to its handler', () => {
    const calls: string[] = [];
    const handlers = {
      onStartBot: (id: string) => calls.push(`start:${id}`),
      onStopBot: (id: string) => calls.push(`stop:${id}`),
      onArmBot: (id: string) => calls.push(`arm:${id}`),
      onDetachSignal: (id: string) => calls.push(`detach:${id}`),
      onTakeOver: (a: { botId?: string; positionId?: string }) => calls.push(`take:${a.botId ?? a.positionId}`),
      onDeployBot: () => calls.push('deploy'),
      onReady: () => calls.push('ready'),
    };
    routeTerminalMessage(buildTerminalMessage({ kind: 'startBot', botId: 'b1' }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'stopBot', botId: 'b2' }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'armBot', botId: 'b3' }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'detachSignal', botId: 'b4' }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'takeOver', positionId: 'p9' }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'deployBot', bot: { strategy: 's', symbol: 'X', timeframe: '1h' } }) as never, handlers);
    routeTerminalMessage(buildTerminalMessage({ kind: 'ready' }) as never, handlers);
    expect(calls).toEqual(['start:b1', 'stop:b2', 'arm:b3', 'detach:b4', 'take:p9', 'deploy', 'ready']);
  });
});

describe('ExecutorHostBridge.handleIncoming', () => {
  it('routes a valid terminal command from the allowed origin', () => {
    const onStartBot = mock(() => {});
    const b = new ExecutorHostBridge({
      target: makeTarget().target,
      terminalOrigin: TERMINAL_ORIGIN,
      handlers: { onStartBot },
    });
    b.handleIncoming({ origin: TERMINAL_ORIGIN, data: buildTerminalMessage({ kind: 'startBot', botId: 'z1' }) });
    expect(onStartBot).toHaveBeenCalledWith('z1');
  });

  it('ignores a foreign origin and reports the rejection', () => {
    const onStartBot = mock(() => {});
    const onReject = mock(() => {});
    const b = new ExecutorHostBridge({
      target: makeTarget().target,
      terminalOrigin: TERMINAL_ORIGIN,
      handlers: { onStartBot, onReject },
    });
    b.handleIncoming({ origin: 'https://evil.example', data: buildTerminalMessage({ kind: 'startBot', botId: 'z1' }) });
    expect(onStartBot).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('origin-not-allowed', expect.anything());
  });

  it('does not act on its own echoed executor message', () => {
    const onStartBot = mock(() => {});
    const onReject = mock(() => {});
    const b = new ExecutorHostBridge({
      target: makeTarget().target,
      terminalOrigin: TERMINAL_ORIGIN,
      handlers: { onStartBot, onReject },
    });
    b.handleIncoming({ origin: TERMINAL_ORIGIN, data: buildExecutorMessage({ kind: 'positions', positions: [] }) });
    expect(onStartBot).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('wrong-direction', expect.anything());
  });
});

describe('ExecutorHostBridge senders', () => {
  it('posts snapshots to the terminal origin only', () => {
    const t = makeTarget();
    const b = new ExecutorHostBridge({
      target: t.target,
      terminalOrigin: TERMINAL_ORIGIN,
      handlers: {},
      executorVersion: '2.0.0',
    });
    b.sendHello();
    b.sendPositions([{ id: 'p', exchange: 'bybit', symbol: 'BTCUSDT', side: 'long', size: 1, entryPrice: 60000 }]);
    b.sendStatus({ online: true, halted: false, connectedExchanges: 1 });
    b.sendBotList([]);
    b.sendFills([]);
    expect(t.posts).toHaveLength(5);
    for (const p of t.posts) {
      expect(p.targetOrigin).toBe(TERMINAL_ORIGIN);
      expect((p.message as { dir: string }).dir).toBe('executor');
    }
    expect((t.posts[0]!.message as { kind: string }).kind).toBe('hello');
    expect((t.posts[0]!.message as { executorVersion: string }).executorVersion).toBe('2.0.0');
  });
});
