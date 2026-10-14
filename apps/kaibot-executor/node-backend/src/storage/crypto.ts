import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

interface CipherGCM {
  update(data: string, inputEncoding: BufferEncoding, outputEncoding: BufferEncoding): string;
  final(outputEncoding: BufferEncoding): string;
  getAuthTag(): Buffer;
}

interface DecipherGCM {
  update(data: string, inputEncoding: BufferEncoding, outputEncoding: BufferEncoding): string;
  final(outputEncoding: BufferEncoding): string;
  setAuthTag(buffer: Buffer): this;
}

const isProd = process.env.NODE_ENV === 'production'
// Desktop (Tauri sidecar): there is no operator to provision APP_SECRET, so a
// per-install persisted random secret (mode 600, like the salt) is the right
// mechanism even in production. The hard APP_SECRET requirement applies to
// headless/server deployments only.
const isDesktop = process.env.TAURI === '1'

// Directory the SQLite DB and crypto material live in (keep in sync with
// storage/database.ts default).
function dataDir(): string {
  return process.env.KAIBOT_DATA_DIR || join(process.cwd(), 'data')
}

// A 32-byte salt generated on first run and persisted next to the DB, so the
// derived key is unique per installation. A shared constant salt let anyone who
// read the SQLite file derive the same key and decrypt every stored API key
// offline.
function resolveSalt(): Buffer {
  const saltPath =
    process.env.CRYPTO_SALT_PATH || join(dataDir(), '.crypto-salt')
  try {
    if (existsSync(saltPath)) {
      const buf = Buffer.from(readFileSync(saltPath, 'utf8').trim(), 'hex')
      if (buf.length === 32) return buf
    }
  } catch {
    // Unreadable/corrupt salt file — regenerate below.
  }
  const salt = randomBytes(32)
  mkdirSync(dirname(saltPath), { recursive: true })
  writeFileSync(saltPath, salt.toString('hex'), { mode: 0o600 })
  return salt
}

// In dev, persist a generated secret so encrypted data survives restarts when
// APP_SECRET isn't set. Never used in production — there APP_SECRET is required.
function resolveDevSecret(): string {
  const secretPath =
    process.env.CRYPTO_DEV_SECRET_PATH || join(dataDir(), '.crypto-dev-secret')
  try {
    if (existsSync(secretPath)) {
      const v = readFileSync(secretPath, 'utf8').trim()
      if (v.length > 0) return v
    }
  } catch {
    // fall through to regenerate
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(secretPath), { recursive: true })
  writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}

function resolveSecret(): string {
  const appSecret = process.env.APP_SECRET
  if (
    appSecret &&
    appSecret.trim().length > 0 &&
    appSecret !== 'dev-secret-change-in-production'
  ) {
    return appSecret
  }
  // No silent public fallback in server production — fail loudly at
  // construction. Desktop production uses the per-install persisted secret
  // (see isDesktop note above); this also keeps pre-existing installs able to
  // decrypt their data.
  if (isProd && !isDesktop) {
    throw new Error('APP_SECRET must be set to a real value in production')
  }
  if (!isProd) {
    console.warn('[crypto] APP_SECRET not set — using a generated local dev secret')
  }
  return resolveDevSecret()
}

export class Crypto {
  private key: Buffer
  private algorithm = 'aes-256-gcm'

  // Migration note: keys stored before per-installation salts were undecryptable
  // with the old constant salt + dev-fallback secret. On the first run after this
  // change a fresh random salt is generated, so any pre-existing ciphertext fails
  // to decrypt and the user must re-enter their exchange API keys (least-risky
  // path — we never weaken the new key derivation to read old data).
  constructor(password?: string) {
    const secret = password || resolveSecret()
    const salt = resolveSalt()
    this.key = scryptSync(secret, salt, 32)
  }

  encrypt(text: string): string {
    const iv = randomBytes(16)
    const cipher = createCipheriv(this.algorithm, this.key, iv) as unknown as CipherGCM

    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    const authTag = cipher.getAuthTag()

    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted
  }

  decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':')
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format')
    }

    const iv = Buffer.from(parts[0], 'hex')
    const authTag = Buffer.from(parts[1], 'hex')
    const encrypted = parts[2]

    const decipher = createDecipheriv(this.algorithm, this.key, iv) as unknown as DecipherGCM
    decipher.setAuthTag(authTag)

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }

  encryptApiKey(apiKey: string): string {
    return this.encrypt(apiKey)
  }

  decryptApiKey(encryptedApiKey: string): string {
    return this.decrypt(encryptedApiKey)
  }

  encryptCredentials(credentials: Record<string, any>): string {
    return this.encrypt(JSON.stringify(credentials))
  }

  decryptCredentials(encryptedCredentials: string): Record<string, any> {
    return JSON.parse(this.decrypt(encryptedCredentials))
  }
}
