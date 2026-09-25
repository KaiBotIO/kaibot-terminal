import path from 'node:path'
import os from 'node:os'
import { EXECUTOR_VERSION, getBuildType, EXECUTOR_PLATFORM } from '../version.js'
import { installService, uninstallService } from './service.js'
import { selfUpdate } from './self-update.js'

const HELP = `kaibot-terminal — headless trading executor daemon

Usage:
  kaibot-terminal                       Run the daemon (serves the web UI)
  kaibot-terminal --profile <name>      Run an isolated instance under ~/.kaibot/executor/<name>
  kaibot-terminal --data-dir <path>     Run an isolated instance against an explicit data dir
  kaibot-terminal service install       Register as a login/boot service
  kaibot-terminal service uninstall     Remove the service
  kaibot-terminal self-update           Update to the latest GitHub release
  kaibot-terminal reset-admin           Remove the local admin account so setup can run again
                                        (lost password; stop the executor first, pass --profile
                                        or --data-dir when the instance uses one)
  kaibot-terminal version               Print version and exit
  kaibot-terminal help                  Show this help

Env:
  PORT                       Force a listen port (default: discovered from 9100/8080)
  KAIBOT_DATA_DIR            Isolated data dir (DB + crypto material + .port)
  KAIBOT_PROFILE             Same as --profile <name>
  KAIBOT_API_URL             Signal service URL
  KAIBOT_DISABLE_UPDATE_CHECK=1   Skip the startup update hint
`

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined
}

// Returns true when a subcommand handled the invocation (caller should exit and
// NOT boot the daemon). Returns false for the bare run / unknown flags.
export async function runCli(argv: string[]): Promise<boolean> {
  const cmd = argv[0]

  switch (cmd) {
    case 'version':
    case '--version':
    case '-v':
      console.log(`kaibot-terminal ${EXECUTOR_VERSION} (${getBuildType()}, ${EXECUTOR_PLATFORM})`)
      return true

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return true

    case 'service': {
      const action = argv[1]
      if (action === 'install') {
        installService({ profile: getFlag(argv, 'profile') })
      } else if (action === 'uninstall') {
        uninstallService()
      } else {
        console.error('Usage: kaibot-terminal service <install|uninstall> [--profile <name>]')
        process.exitCode = 1
      }
      return true
    }

    case 'self-update':
      await selfUpdate()
      return true

    // Local lockout recovery: wipes the admin user + sessions from the local DB
    // so the web UI offers first-run setup again. Requires filesystem access to
    // the data dir by design — there is no remote/HTTP reset path.
    case 'reset-admin': {
      const profile = getFlag(argv, 'profile') || process.env.KAIBOT_PROFILE
      const explicitDataDir = getFlag(argv, 'data-dir') || process.env.KAIBOT_DATA_DIR
      // Mirror main.ts data-dir resolution so we open the same kaibot.db.
      const dataDir = explicitDataDir
        ? path.resolve(explicitDataDir)
        : profile
          ? path.join(os.homedir(), '.kaibot', 'executor', profile)
          : undefined
      if (dataDir) process.env.KAIBOT_DATA_DIR = dataDir
      const { KaiBotDatabase } = await import('../storage/database.js')
      const db = new KaiBotDatabase()
      try {
        if (!(await db.hasAdminUser())) {
          console.log('No admin account found — nothing to reset. Start the executor and open the UI to create one.')
          return true
        }
        db.resetAdminUser()
        console.log('Admin account and all sessions removed.')
        console.log('Restart the executor, open its UI and create a new account.')
      } finally {
        db.close()
      }
      return true
    }

    default:
      return false
  }
}
