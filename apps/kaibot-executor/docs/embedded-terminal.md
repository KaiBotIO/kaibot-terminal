# Embedded online terminal (executor /terminal)

The executor shell embeds the ONLINE terminal (`apps/frontend`) in an iframe on
the `/terminal` route and bridges it to the executor LOCAL api via `postMessage`.
The TV Charting Library stays served from the online origin and is **never**
bundled into the executor (enforced by `tests/carve-out/INV8-no-tv-lib-in-executor.test.ts`).

## Data flow

- `executor host → iframe`: `positions`, `fills`, `status`, `botList` (so local
  fills plot on the chart — stays local, "nothing rolls back").
- `iframe → executor`: `deployBot`, `armBot`, `startBot`, `stopBot`, `takeOver`,
  `detachSignal` → routed to the executor LOCAL api (`/api/bots/*`, Task A).

Protocol contract: `@kaibot/terminal-bridge` (typed, versioned, pure (de)serialisers
+ origin guard). Host side: `src/hooks/useTerminalBridge.ts` + `src/pages/Terminal.tsx`.
Terminal side mounts `TerminalClientBridge` (apps/frontend, owned by the terminal agent).

## Config

- `VITE_ONLINE_TERMINAL_URL` (executor frontend) — the embedded origin. Defaults
  to the deployed online terminal. Drives both the iframe `src` and the
  postMessage `targetOrigin` / inbound origin allowlist (`ONLINE_TERMINAL_ORIGIN`).
- `src-tauri/capabilities/default.json` `remote.urls` — the online origin is
  allowlisted so Tauri APIs are reachable from the embedded content if needed.
  A plain iframe of remote content renders without it; the allowlist only gates
  the Tauri IPC surface.
- `src-tauri/tauri.conf.json` `app.security.csp = null` — no shell-imposed
  `frame-ancestors`, so the webview may frame the remote origin.

## Frame-ancestors (deploy-side — NOT in this repo)

The ONLINE origin (`apps/frontend`) must permit being framed by the executor.
Set this header where `apps/frontend` is **hosted** (reverse proxy / CDN), since
Vite-built static output carries no response headers:

```
Content-Security-Policy: frame-ancestors 'self' tauri://localhost http://localhost:* http://127.0.0.1:*
```

Do NOT send a conflicting `X-Frame-Options: DENY/SAMEORIGIN` — it overrides
`frame-ancestors` in some browsers and would block the embed.

## Manual verification (live-only)

Unit-testable parts are covered (`@kaibot/terminal-bridge` 33 tests, INV8). The
cross-document round trip needs a real browser:

1. Serve the online terminal with the `frame-ancestors` header set.
2. Run the executor (`reference_executor_playwright` recipe) and open `/terminal`.
3. Confirm the iframe renders the online terminal + TV chart.
4. Trigger a local fill; confirm it plots on the embedded chart (executor →
   `sendFills`/`sendPositions` → `buildPositionLines` → `setPositionLines`).
5. From the embedded chart, start/stop a bot; confirm it reaches `/api/bots/:id/*`
   and the next snapshot reflects the new status.
