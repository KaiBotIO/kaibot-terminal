# Running the executor headless (CLI & Docker)

The desktop app and the headless binary are the **same daemon** — the desktop
app is just a tray shell around it. To run the executor 24/7 on a server or
homelab box, run the binary directly or in Docker. It serves the same web UI on
its port; open `http://<host>:<port>` in a browser.

## Install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/KaiBotIO/kaibot-terminal/main/apps/kaibot-executor/scripts/install.sh | bash
```

This downloads the latest release binary for your platform into `~/.local/bin`.
Set `KAIBOT_INSTALL_SERVICE=1` to also register it as a login/boot service.

## Commands

```
kaibot-terminal                    Run the daemon (serves the web UI)
kaibot-terminal --profile <name>   Isolated instance under ~/.kaibot/executor/<name>
kaibot-terminal service install    Register as a login/boot service
kaibot-terminal service uninstall  Remove the service
kaibot-terminal self-update        Update to the latest GitHub release
kaibot-terminal reset-admin        Remove the local admin account (lost password)
kaibot-terminal version            Print version
kaibot-terminal help               Show help
```

`service install` uses the native mechanism per OS:
- **macOS** — a launchd LaunchAgent at `~/Library/LaunchAgents/io.kaibot.terminal.plist`
- **Linux** — a systemd `--user` unit (run `loginctl enable-linger $USER` for boot-time start without login)
- **Windows** — an `HKCU\…\Run` registry entry

## Lost password (admin reset)

The executor account is local-only — there is no email reset and no remote
reset endpoint. Recovery requires filesystem access to the data dir, which is
the point: whoever owns the machine owns the account.

```bash
# stop the executor first, then:
kaibot-terminal reset-admin                 # default data dir
kaibot-terminal reset-admin --profile prod  # a --profile instance
kaibot-terminal reset-admin --data-dir /data  # an explicit data dir (Docker: run inside the container)
```

This deletes the admin user and all sessions from the local DB. Start the
executor again and the UI offers first-run setup. Exchange connections, bots
and history are untouched — but the **API pairing is not**: the apiConfig
(API URL + key, auto-connect) lives in the admin user's settings and is wiped
with it. After every reset, re-enter the API key under Settings → API
Configuration and confirm `ws/status` reports connected, or the executor runs
disconnected from the signal service without any error. See
`e2e-hardening-2026-08-24.md`.

## Updates

The standalone binary checks GitHub on start and logs a hint when a newer
release is out; `kaibot-terminal self-update` downloads and swaps the binary in
place (restart to apply). The API also enforces a minimum version over the WS
handshake — an executor below the floor is refused with `426 Upgrade Required`,
so keeping current is not optional once a floor is set.

## Docker

The image is a thin wrapper around the prebuilt Linux binary + web UI. Build
from the release artifacts (CI publishes these):

```bash
docker build -t kaibot-terminal \
  --build-arg BINARY=kaibot-terminal-x86_64-unknown-linux-gnu \
  -f apps/kaibot-executor/Dockerfile .

docker run -d --name kaibot-terminal \
  -p 8080:8080 \
  -v kaibot-data:/data \
  -e KAIBOT_API_URL=https://api.example.com \
  -e EXECUTOR_SESSION_TOKEN=... \
  kaibot-terminal
```

State (DB, `.port`) persists in the `/data` volume. The UI is at
`http://<host>:8080`. The image sets `KAIBOT_BUILD_TYPE=docker`, so adoption
telemetry reports it correctly.
