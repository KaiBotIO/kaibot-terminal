// Serving of the built web UI (dist) for every mode: desktop (the Tauri webview
// navigates here), web and Docker all hit the same bundle.
//
// This deliberately does NOT use hono's serveStatic: that middleware resolves
// `root` against the cwd (it strips a leading slash and prefixes `./`), while
// the dist dir is resolved to an ABSOLUTE path that is cwd-independent on
// purpose — the cwd differs per packaging (Docker runs WORKDIR /data with
// KAIBOT_STATIC_DIR=/opt/kaibot/dist, the Tauri shell launches from anywhere).

import path from 'node:path'
import type { Hono } from 'hono'

// Map a request path onto a file inside `staticPath`, or undefined when it
// escapes the dir or there is no dist at all.
export function resolveStaticFile(
  staticPath: string | undefined,
  requestPath: string,
): string | undefined {
  if (!staticPath) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return undefined // malformed percent-encoding
  }
  const full = path.resolve(staticPath, `.${decoded}`)
  // Keep `..` segments from escaping dist.
  if (full !== staticPath && !full.startsWith(staticPath + path.sep)) return undefined
  return full
}

// The content type must be passed explicitly: @hono/node-server swaps the
// global Response for its own, which ignores a Blob body's type and defaults
// every file to text/plain — enough for a browser to refuse the bundle under
// the strict MIME check for module scripts. Bun infers the type from the
// extension and falls back to application/octet-stream.
export async function serveStaticFile(filePath: string): Promise<Response | undefined> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  return new Response(file, { headers: { 'content-type': file.type } })
}

export function registerStaticUi(app: Hono, staticPath: string | undefined): void {
  // Hashed assets (js, css, images, fonts). A miss 404s instead of falling
  // through to the SPA shell below: /assets/* is never a client route, and
  // answering a stale bundle with HTML surfaces in the browser as an opaque
  // MIME error rather than the missing file it is.
  app.get('/assets/*', async (c) => {
    const filePath = resolveStaticFile(staticPath, c.req.path)
    const res = filePath ? await serveStaticFile(filePath) : undefined
    return res ?? c.text('Not found', 404)
  })

  // SPA fallback: serve index.html for the root and any non-API route.
  app.get('/*', async (c) => {
    const requestPath = c.req.path

    // Skip API routes
    if (requestPath.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Real files at the dist root (favicon, icons, loading.html) win over the
    // fallback; anything else is a client route and gets the SPA shell.
    if (requestPath !== '/') {
      const filePath = resolveStaticFile(staticPath, requestPath)
      const res = filePath ? await serveStaticFile(filePath) : undefined
      if (res) return res
    }

    try {
      if (!staticPath) throw new Error('no dist directory found')
      const indexPath = path.join(staticPath, 'index.html')
      const indexContent = await Bun.file(indexPath).text()
      return c.html(indexContent)
    } catch {
      // If dist folder doesn't exist, show helpful message
      return c.html(`
        <html>
          <body style="font-family: system-ui; padding: 2rem; max-width: 800px; margin: 0 auto;">
            <h1>KaiBot Terminal</h1>
            <p>The web UI is not built yet.</p>
            <p>To build and run the web UI:</p>
            <pre style="background: #f0f0f0; padding: 1rem; border-radius: 4px;">
cd ../.. # Go to executor root
bun run build
bun run dev:backend</pre>
            <p>Or run the frontend dev server separately:</p>
            <pre style="background: #f0f0f0; padding: 1rem; border-radius: 4px;">
cd ../.. # Go to executor root
bun run dev:web</pre>
          </body>
        </html>
      `)
    }
  })
}
