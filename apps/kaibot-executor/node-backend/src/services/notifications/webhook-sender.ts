// Generic outbound webhook sender (parity #8 with kaibot-exec gchat alerting).
//
// POSTs {text} JSON to a configured URL — the shape Google Chat (and Slack-
// compatible) incoming webhooks accept. Retries a few times with backoff and
// NEVER throws into the caller: alerting must never block or break the order
// flow. Fire-and-forget from the order path; awaitable in tests.

export interface WebhookSenderOptions {
  retries?: number
  // Base backoff in ms; doubled each attempt.
  backoffMs?: number
  timeoutMs?: number
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
}

export interface WebhookResult {
  ok: boolean
  status?: number
  attempts: number
  error?: string
}

export async function sendWebhook(
  url: string,
  text: string,
  options: WebhookSenderOptions = {},
): Promise<WebhookResult> {
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 500
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch = options.fetchImpl ?? fetch

  let lastError = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status < 400) return { ok: true, status: res.status, attempts: attempt }
      lastError = `HTTP ${res.status}`
      // 4xx (other than 429) won't fix itself on retry — stop early.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, attempts: attempt, error: lastError }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)))
    }
  }
  return { ok: false, attempts: retries, error: lastError }
}
