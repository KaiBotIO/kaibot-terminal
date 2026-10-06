// Cloud recovery-ladder compose — thin client for the PROTECTED server
// calculator (tRPC manualTools.computeRecoveryLadder). The formula never runs
// on this box: the executor sends band inputs with the user's own kb_ API key
// and gets back rung prices + sizes only. No local reimplementation, ever.

export interface RecoveryComposeInput {
  extreme: number
  entry: number
  totalQty: number
  assetClass: 'crypto' | 'tradfi'
  levels?: number
  tickSize?: number
  sizeStep?: number
  includeRecoveryTail?: boolean
}

export interface RecoveryComposeResult {
  rungs: Array<{ price: number; size: number }>
  avgIfAllFilled: number
  meta: { levelsUsed: number }
}

export type RecoveryComposeErrorCode =
  | 'no-config' // no API URL / key configured on this executor
  | 'unauthorized' // key rejected by the server
  | 'forbidden' // entitlement gate (plan / tradfi access)
  | 'rate-limited'
  | 'bad-request' // server-side input validation
  | 'unavailable' // network / malformed response

export class RecoveryComposeError extends Error {
  constructor(
    message: string,
    public readonly code: RecoveryComposeErrorCode,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'RecoveryComposeError'
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RecoveryComposeDeps {
  getApiUrl: () => string | null
  getApiKey: () => string | null
  fetchImpl?: FetchLike
}

function codeForStatus(status: number): RecoveryComposeErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'bad-request'
  return 'unavailable'
}

// The entitlement gate replies with machine-readable prefixes; turn them into
// something a human can read in a toast.
function humanizeServerMessage(raw: unknown, status: number): string {
  const msg = typeof raw === 'string' && raw.length > 0 ? raw : ''
  if (msg.startsWith('UPGRADE_REQUIRED')) return 'Not available on your plan.'
  if (msg === 'BILLING_UNAVAILABLE') return 'Billing is unavailable right now — try again later.'
  if (msg) return msg
  return `Cloud API error (HTTP ${status})`
}

export interface RecoveryComposeService {
  compose(input: RecoveryComposeInput): Promise<RecoveryComposeResult>
}

export function createRecoveryComposeService(deps: RecoveryComposeDeps): RecoveryComposeService {
  return {
    async compose(input: RecoveryComposeInput): Promise<RecoveryComposeResult> {
      const apiUrl = deps.getApiUrl()
      const apiKey = deps.getApiKey()
      if (!apiUrl || !apiKey) {
        throw new RecoveryComposeError(
          'Cloud API not configured — set your API URL and key in Settings.',
          'no-config',
          0,
        )
      }

      const f: FetchLike = deps.fetchImpl ?? fetch
      let res: Response
      try {
        res = await f(`${apiUrl}/api/trpc/manualTools.computeRecoveryLadder`, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          // superjson envelope — matches the appRouter transformer.
          body: JSON.stringify({ json: input }),
        })
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        throw new RecoveryComposeError(`Cloud API unreachable: ${m}`, 'unavailable', 0)
      }

      const body = (await res.json().catch(() => null)) as any
      if (!res.ok) {
        const errNode = body?.error?.json ?? body?.error
        throw new RecoveryComposeError(
          humanizeServerMessage(errNode?.message, res.status),
          codeForStatus(res.status),
          res.status,
        )
      }

      const data = (body?.result?.data?.json ?? body?.result?.data) as
        | RecoveryComposeResult
        | undefined
      if (
        !data ||
        !Array.isArray(data.rungs) ||
        typeof data.avgIfAllFilled !== 'number' ||
        data.rungs.some(
          (r) => typeof r?.price !== 'number' || typeof r?.size !== 'number',
        )
      ) {
        throw new RecoveryComposeError('Malformed calculator response', 'unavailable', res.status)
      }
      return { rungs: data.rungs, avgIfAllFilled: data.avgIfAllFilled, meta: data.meta }
    },
  }
}
