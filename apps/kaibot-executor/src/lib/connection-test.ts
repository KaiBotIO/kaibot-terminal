// Interpret the /api/test-connection response body. Non-2xx replies already
// throw in api.post; this covers the 200-with-{success:false} case, which used
// to fall through with no user feedback.

export interface ConnectionTestResponse {
  success?: boolean;
  message?: string;
  error?: string;
}

export type ConnectionTestOutcome = { ok: true } | { ok: false; message: string };

export function interpretConnectionTest(res: ConnectionTestResponse | null | undefined): ConnectionTestOutcome {
  if (res?.success) return { ok: true };
  return { ok: false, message: res?.error || res?.message || "Connection test failed" };
}
