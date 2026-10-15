// Build-time edition (vite.config.ts bakes it from KAIBOT_EDITION). Mirrors
// node-backend/src/edition.ts: anything but "internal" is the public build,
// which has no viewer accounts.
export type Edition = 'internal' | 'public';

export const EDITION: Edition = import.meta.env.VITE_KAIBOT_EDITION === 'internal' ? 'internal' : 'public';

export const HAS_VIEWER_ACCOUNTS = EDITION === 'internal';
