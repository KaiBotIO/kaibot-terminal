import { isDesktop } from './utils';
import { apiFetch } from './api';

// Self-update flow for the desktop shell. Two hard rules:
//  1. Updater APIs only exist inside Tauri — guard every call with isDesktop()
//     and import the plugins dynamically so the web bundle never pulls them in.
//  2. Never download/install/relaunch while the executor is managing open
//     positions or orders. A relaunch drops the WS link and the in-memory OCO
//     bracket tracking mid-flight; we wait until the user is flat.

export function isUpdaterAvailable(): boolean {
  return isDesktop();
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isDesktop()) return { available: false };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return { available: false };
    return { available: true, version: update.version, notes: update.body };
  } catch (err) {
    console.error('Update check failed:', err);
    return { available: false };
  }
}

// True when the executor still has open positions — i.e. a restart would be
// disruptive. Best-effort: if we can't tell, assume active and refuse.
export async function hasActiveTrades(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/positions');
    if (!res.ok) return true;
    const positions = (await res.json()) as unknown[];
    return Array.isArray(positions) && positions.length > 0;
  } catch {
    return true;
  }
}

export type InstallOutcome =
  | { status: 'installed' }
  | { status: 'no-update' }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; reason: string };

// Download + install the pending update and relaunch — but only when flat.
export async function installUpdateIfSafe(): Promise<InstallOutcome> {
  if (!isDesktop()) return { status: 'blocked', reason: 'Updates are managed by your package manager in CLI/Docker mode.' };

  if (await hasActiveTrades()) {
    return {
      status: 'blocked',
      reason: 'Open positions are being managed. Close them before updating so a restart never interrupts an active trade.',
    };
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');
    const update = await check();
    if (!update) return { status: 'no-update' };

    await update.downloadAndInstall();

    // Re-check right before relaunch: a signal could have opened a position
    // during the download. If so, leave the update staged for next launch.
    if (await hasActiveTrades()) {
      return {
        status: 'blocked',
        reason: 'A position opened during download. The update is staged and will apply next time you restart while flat.',
      };
    }

    await relaunch();
    return { status: 'installed' };
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
