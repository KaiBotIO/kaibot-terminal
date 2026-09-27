import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerStaticUi, resolveStaticFile, serveStaticFile } from './static-ui.js'

// Regression: the executor served a blank white page in web/Docker mode.
//
// dist is resolved to an ABSOLUTE dir (KAIBOT_STATIC_DIR=/opt/kaibot/dist in
// Docker, WORKDIR /data), but hono's serveStatic resolves `root` against the
// cwd — it strips the leading slash and prefixes `./`, so every asset missed
// and fell through to the SPA fallback, which answered the JS bundle with
// index.html. The browser then refused the module script over its MIME type
// and React never mounted.
//
// Two independent failure modes are locked in here: the path must resolve from
// an absolute dir regardless of cwd, and the response must carry an explicit
// content type (@hono/node-server replaces the global Response with one that
// ignores a Blob body's type and defaults everything to text/plain).

let distDir: string
const realCwd = process.cwd()

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaibot-static-'))
  fs.mkdirSync(path.join(distDir, 'assets'))
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'export const mounted = true')
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.css'), '.root{color:red}')
  fs.writeFileSync(path.join(distDir, 'favicon.ico'), 'icon-bytes')
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>')
})

afterAll(() => {
  process.chdir(realCwd)
  fs.rmSync(distDir, { recursive: true, force: true })
})

afterEach(() => {
  process.chdir(realCwd)
})

describe('resolveStaticFile', () => {
  it('resolves an asset from an absolute dist dir regardless of cwd', () => {
    // The original bug: an absolute root was turned into a cwd-relative path.
    process.chdir(os.tmpdir())
    const resolved = resolveStaticFile(distDir, '/assets/index-abc123.js')
    expect(resolved).toBe(path.join(distDir, 'assets', 'index-abc123.js'))
    expect(fs.existsSync(resolved!)).toBe(true)
  })

  it('keeps traversal inside dist', () => {
    expect(resolveStaticFile(distDir, '/assets/../../../etc/passwd')).toBeUndefined()
    expect(resolveStaticFile(distDir, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined()
  })

  it('returns undefined without a dist dir or on malformed encoding', () => {
    expect(resolveStaticFile(undefined, '/assets/index-abc123.js')).toBeUndefined()
    expect(resolveStaticFile(distDir, '/assets/%E0%A4%A.js')).toBeUndefined()
  })
})

describe('serveStaticFile', () => {
  it('sets a JS content type even when Response ignores the blob type', async () => {
    // Stand in for @hono/node-server's Response: it drops a Blob body's type
    // and defaults to text/plain unless init.headers says otherwise.
    const NativeResponse = globalThis.Response
    class BlobTypeBlindResponse extends NativeResponse {
      constructor(...[body, init]: ConstructorParameters<typeof NativeResponse>) {
        super(body, { ...init, headers: init?.headers ?? { 'content-type': 'text/plain; charset=UTF-8' } })
      }
    }
    globalThis.Response = BlobTypeBlindResponse as unknown as typeof Response
    try {
      const res = await serveStaticFile(path.join(distDir, 'assets', 'index-abc123.js'))
      expect(res!.headers.get('content-type')).toContain('javascript')
    } finally {
      globalThis.Response = NativeResponse
    }
  })

  it('returns undefined for a file that does not exist', async () => {
    expect(await serveStaticFile(path.join(distDir, 'assets', 'gone.js'))).toBeUndefined()
  })
})

describe('registerStaticUi', () => {
  const appFor = (dir: string | undefined) => {
    const app = new Hono()
    registerStaticUi(app, dir)
    return app
  }

  it('serves the JS bundle as javascript, never as the SPA shell', async () => {
    process.chdir(os.tmpdir())
    const res = await appFor(distDir).request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toBe('export const mounted = true')
  })

  it('serves css and dist-root files with their own type', async () => {
    const app = appFor(distDir)
    const css = await app.request('/assets/index-abc123.css')
    expect(css.headers.get('content-type')).toContain('css')
    const icon = await app.request('/favicon.ico')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).not.toContain('text/html')
  })

  it('404s a missing asset instead of answering with html', async () => {
    const res = await appFor(distDir).request('/assets/stale-hash.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toContain('text/html')
  })

  it('serves the SPA shell for the root and client routes', async () => {
    const app = appFor(distDir)
    for (const route of ['/', '/login', '/positions']) {
      const res = await app.request(route)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    }
  })

  it('404s unknown api routes as json rather than the shell', async () => {
    const res = await appFor(distDir).request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('explains itself when dist is missing', async () => {
    const res = await appFor(undefined).request('/')
    expect(await res.text()).toContain('not built yet')
  })
})
