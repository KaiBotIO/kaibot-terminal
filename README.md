# KaiBot Terminal

The local executor for [KaiBot Studio](https://kaibot.io). It holds your
exchange API keys and places the orders — both stay on your machine. The
KaiBot servers never see your keys and cannot place a trade on your account.

How it works: your bots on KaiBot Studio emit signals (entries, exits,
cancels). The executor receives them over a websocket you pair yourself, checks
them against your own limits, and executes them on your exchange. Server-pushed
stop moves are refused outright. Any local exit management (trailing stops,
guardrails) runs only from config you set yourself.

## Install

**Desktop** (recommended): download the installer for your OS from
[Releases](https://github.com/KaiBotIO/kaibot-terminal/releases/latest) —
macOS `.dmg` (universal), Windows installer, Linux `.AppImage`/`.deb`. The app
updates itself via the built-in updater.

**Server / headless** (Docker):

```sh
docker run -d --name kaibot-terminal \
  -p 8080:8080 \
  -v kaibot-terminal-data:/data \
  ghcr.io/kaibotio/kaibot-terminal:latest
```

**Standalone binary**: each release also has `kaibot-terminal-<target>.tar.gz`
tarballs with a compiled daemon plus the web UI. Unpack and run
`./kaibot-terminal`.

Headless and Docker details (flags, data dir, setup token):
[`apps/kaibot-executor/docs/cli-and-docker.md`](apps/kaibot-executor/docs/cli-and-docker.md).

## Build from source

Requires [Bun](https://bun.sh) ≥ 1.0.15. For the desktop app you also need the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust, plus
webkit2gtk on Linux).

```sh
bun install
bun run build          # daemon + web UI
bun run build:desktop  # Tauri desktop bundle
bun run dev:web        # dev: web UI on :1420, backend on :8080
bun test               # backend unit tests
```

## Repo layout

```
apps/kaibot-executor/   Tauri shell, web UI, and the Bun/Hono daemon (node-backend/)
packages/shared/        shared UI components
packages/terminal-bridge/  websocket protocol between terminal and executor
packages/types/         shared TypeScript types
```

This repo is a source mirror of the executor part of the private KaiBot
monorepo. Each release re-exports a fresh snapshot, so the git history here is
per-release, not per-commit. Issues and discussions are welcome; pull requests
can't be merged here directly, but we read them and apply accepted changes
upstream, credited in the release notes.

## License & disclaimer

AGPL-3.0-only — see [LICENSE](LICENSE).

The executor is provided as is, without warranty of any kind (AGPL §15–16),
without support and without any uptime commitment. It places real orders on
your exchange account with your own API keys: running it, configuring it and
monitoring it — including intervening directly on your exchange when the
executor or an exchange session goes down — is entirely your own
responsibility. Trading with it is at your own risk.
