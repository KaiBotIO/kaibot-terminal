import { describe, expect, it, mock } from 'bun:test';
import { TerminalClientBridge, routeExecutorMessage } from '../client.js';
import { buildExecutorMessage, buildTerminalMessage } from '../serde.js';

const EXEC_ORIGIN = 'http://127.0.0.1:8080';

function makeParent() {
  const posts: Array<{ message: unknown; targetOrigin: string }> = [];
  return { posts, parent: { postMessage: (m: unknown, o: string) => posts.push({ message: m, targetOrigin: o }) } };
}

describe('routeExecutorMessage', () => {
  it('dispatches data messages to handlers', () => {
    const seen: string[] = [];
    routeExecutorMessage(buildExecutorMessage({ kind: 'positions', positions: [] }) as never, {
      onPositions: () => seen.push('pos'),
    });
    routeExecutorMessage(buildExecutorMessage({ kind: 'fills', fills: [] }) as never, {
      onFills: () => seen.push('fills'),
    });
    routeExecutorMessage(buildExecutorMessage({ kind: 'hello', executorVersion: '1' }) as never, {
      onHello: (v) => seen.push(`hello:${v}`),
    });
    expect(seen).toEqual(['pos', 'fills', 'hello:1']);
  });
});

describe('TerminalClientBridge.handleIncoming', () => {
  it('feeds positions from the executor origin into onPositions', () => {
    const onPositions = mock(() => {});
    const c = new TerminalClientBridge({ parent: makeParent().parent, executorOrigin: EXEC_ORIGIN, handlers: { onPositions } });
    const positions = [{ id: 'p', exchange: 'bybit', symbol: 'BTCUSDT', side: 'long' as const, size: 1, entryPrice: 60000 }];
    c.handleIncoming({ origin: EXEC_ORIGIN, data: buildExecutorMessage({ kind: 'positions', positions }) });
    expect(onPositions).toHaveBeenCalledWith(positions);
  });

  it('rejects data from a foreign origin', () => {
    const onPositions = mock(() => {});
    const onReject = mock(() => {});
    const c = new TerminalClientBridge({ parent: makeParent().parent, executorOrigin: EXEC_ORIGIN, handlers: { onPositions, onReject } });
    c.handleIncoming({ origin: 'https://evil.example', data: buildExecutorMessage({ kind: 'positions', positions: [] }) });
    expect(onPositions).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('origin-not-allowed', expect.anything());
  });

  it('ignores an echoed terminal command', () => {
    const onReject = mock(() => {});
    const c = new TerminalClientBridge({ parent: makeParent().parent, executorOrigin: EXEC_ORIGIN, handlers: { onReject } });
    c.handleIncoming({ origin: EXEC_ORIGIN, data: buildTerminalMessage({ kind: 'startBot', botId: 'x' }) });
    expect(onReject).toHaveBeenCalledWith('wrong-direction', expect.anything());
  });
});

describe('TerminalClientBridge command emitters', () => {
  it('posts commands to the executor origin with terminal dir', () => {
    const p = makeParent();
    const c = new TerminalClientBridge({ parent: p.parent, executorOrigin: EXEC_ORIGIN, handlers: {} });
    c.sendReady();
    c.startBot('b1');
    c.stopBot('b2');
    c.takeOver({ positionId: 'p9' });
    c.detachSignal('b3');
    c.deployBot({ strategy: 's', symbol: 'X', timeframe: '1h' }, true);
    expect(p.posts).toHaveLength(6);
    for (const post of p.posts) {
      expect(post.targetOrigin).toBe(EXEC_ORIGIN);
      expect((post.message as { dir: string }).dir).toBe('terminal');
    }
    expect((p.posts[5]!.message as { arm: boolean }).arm).toBe(true);
  });
});
