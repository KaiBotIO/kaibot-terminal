import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Per-OS service install for the headless daemon. Registers the running binary
// to start at login/boot so a VPS or homelab box keeps the executor up without
// the desktop shell. Idempotent: install overwrites, uninstall is best-effort.

const LABEL = 'io.kaibot.terminal'

function binaryPath(): string {
  // The compiled binary's own path. In `bun run` dev this points at bun, which
  // is fine for testing the flow but not what you'd install in production.
  return process.execPath
}

interface ServiceOptions {
  profile?: string
}

function args(opts: ServiceOptions): string[] {
  return opts.profile ? ['--profile', opts.profile] : []
}

// ---- macOS: launchd LaunchAgent ----

function macPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function macInstall(opts: ServiceOptions): void {
  const programArgs = [binaryPath(), ...args(opts)]
    .map((a) => `    <string>${a}</string>`)
    .join('\n')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), 'Library', 'Logs', 'kaibot-terminal.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), 'Library', 'Logs', 'kaibot-terminal.log')}</string>
</dict>
</plist>
`
  const dest = macPlistPath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, plist)
  spawnSync('launchctl', ['unload', dest], { stdio: 'ignore' })
  const res = spawnSync('launchctl', ['load', dest], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('launchctl load failed')
  console.log(`Installed launchd agent → ${dest}`)
}

function macUninstall(): void {
  const dest = macPlistPath()
  spawnSync('launchctl', ['unload', dest], { stdio: 'ignore' })
  try {
    fs.unlinkSync(dest)
  } catch {
    /* already gone */
  }
  console.log(`Removed launchd agent → ${dest}`)
}

// ---- Linux: systemd --user unit ----

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'kaibot-terminal.service')
}

function linuxInstall(opts: ServiceOptions): void {
  const execStart = [binaryPath(), ...args(opts)].join(' ')
  const unit = `[Unit]
Description=KaiBot Terminal daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
  const dest = systemdUnitPath()
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, unit)
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  const res = spawnSync('systemctl', ['--user', 'enable', '--now', 'kaibot-terminal.service'], {
    stdio: 'inherit',
  })
  if (res.status !== 0) throw new Error('systemctl enable failed')
  console.log(`Installed systemd user unit → ${dest}`)
  console.log('Tip: run `loginctl enable-linger $USER` so it runs without an active login session.')
}

function linuxUninstall(): void {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'kaibot-terminal.service'], {
    stdio: 'ignore',
  })
  try {
    fs.unlinkSync(systemdUnitPath())
  } catch {
    /* already gone */
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  console.log('Removed systemd user unit')
}

// ---- Windows: HKCU Run key ----

function windowsInstall(opts: ServiceOptions): void {
  const value = `"${binaryPath()}" ${args(opts).join(' ')}`.trim()
  const res = spawnSync(
    'reg',
    ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'KaiBotExecutor', '/t', 'REG_SZ', '/d', value, '/f'],
    { stdio: 'inherit' },
  )
  if (res.status !== 0) throw new Error('reg add failed')
  console.log('Installed Windows Run-key (starts at login)')
}

function windowsUninstall(): void {
  spawnSync(
    'reg',
    ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'KaiBotExecutor', '/f'],
    { stdio: 'ignore' },
  )
  console.log('Removed Windows Run-key')
}

export function installService(opts: ServiceOptions = {}): void {
  switch (process.platform) {
    case 'darwin':
      return macInstall(opts)
    case 'linux':
      return linuxInstall(opts)
    case 'win32':
      return windowsInstall(opts)
    default:
      throw new Error(`Service install not supported on ${process.platform}`)
  }
}

export function uninstallService(): void {
  switch (process.platform) {
    case 'darwin':
      return macUninstall()
    case 'linux':
      return linuxUninstall()
    case 'win32':
      return windowsUninstall()
    default:
      throw new Error(`Service uninstall not supported on ${process.platform}`)
  }
}
