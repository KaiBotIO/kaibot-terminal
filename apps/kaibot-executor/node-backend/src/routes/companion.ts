// LOCAL-ONLY companion control routes for the executor's OWN UI.
//
// These drive the "Remote management" toggle in the executor Settings/Safety
// page: enable/disable remote management, read the pairing code to show, unpair.
// They are NOT the relay path — the relay carries sealed blobs over the WS. The
// executor UI hits these directly (loopback/desktop-trusted or session-gated).

import { Hono } from 'hono';
import type { CompanionService } from '../services/companion.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createCompanionRoutes(
  companion: CompanionService,
  onChange?: () => void,
) {
  const app = new Hono();

  // Current opt-in status + paired devices (NOT the code — fetch that separately).
  app.get('/status', (c) => {
    const s = companion.getStatus();
    return c.json({ enabled: s.enabled, enabledAt: s.enabledAt, devices: s.devices });
  });

  // Turn remote management ON — mints + returns the pairing code to show.
  app.post('/enable', (c) => {
    try {
      const status = companion.enableCompanion();
      onChange?.();
      return c.json(status);
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500);
    }
  });

  // Turn remote management OFF — unpairs all devices, resumes refusing commands.
  app.post('/disable', (c) => {
    try {
      const status = companion.disableCompanion();
      onChange?.();
      return c.json(status);
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500);
    }
  });

  // The active pairing code (only while enabled). Wave-1 placeholder string.
  app.get('/pairing-code', (c) => {
    return c.json({ code: companion.getPairingCode() });
  });

  // Unpair one device by id.
  app.post('/unpair', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string };
      if (!body.id) return c.json({ error: 'id required' }, 400);
      companion.unpairDevice(body.id);
      onChange?.();
      return c.json(companion.getStatus());
    } catch (error) {
      return c.json({ error: errMsg(error) }, 500);
    }
  });

  return app;
}
