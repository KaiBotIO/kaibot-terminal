import { describe, expect, it } from 'bun:test'
import { sendWebhook } from './webhook-sender.js'

function fakeFetch(responses: Array<number | 'throw'>) {
  let i = 0
  const calls: Array<{ url: string; body: any }> = []
  const fn = (async (url: string, init?: any) => {
    const r = responses[Math.min(i, responses.length - 1)]
    calls.push({ url, body: JSON.parse(init.body) })
    i++
    if (r === 'throw') throw new Error('network down')
    return { status: r } as Response
  }) as unknown as typeof fetch
  return { fn, calls, count: () => i }
}

describe('sendWebhook', () => {
  it('posts {text} and succeeds on a 2xx', async () => {
    const f = fakeFetch([200])
    const r = await sendWebhook('http://hook', 'hello', { fetchImpl: f.fn })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(f.calls[0].body).toEqual({ text: 'hello' })
  })

  it('retries on a 5xx then succeeds', async () => {
    const f = fakeFetch([500, 200])
    const r = await sendWebhook('http://hook', 'x', { fetchImpl: f.fn, backoffMs: 1 })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
  })

  it('retries on a thrown network error', async () => {
    const f = fakeFetch(['throw', 200])
    const r = await sendWebhook('http://hook', 'x', { fetchImpl: f.fn, backoffMs: 1 })
    expect(r.ok).toBe(true)
    expect(f.count()).toBe(2)
  })

  it('gives up after the retry budget on persistent failure', async () => {
    const f = fakeFetch([500, 500, 500])
    const r = await sendWebhook('http://hook', 'x', { fetchImpl: f.fn, retries: 3, backoffMs: 1 })
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
  })

  it('does not retry a 4xx (other than 429)', async () => {
    const f = fakeFetch([400, 200])
    const r = await sendWebhook('http://hook', 'x', { fetchImpl: f.fn, backoffMs: 1 })
    expect(r.ok).toBe(false)
    expect(f.count()).toBe(1)
  })
})
