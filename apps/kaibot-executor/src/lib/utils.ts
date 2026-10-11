export { cn } from "@kaibot/shared";

let cachedIsDesktop: boolean | null = null;

export function isDesktop() {
  // Return cached value if already determined
  if (cachedIsDesktop !== null) return cachedIsDesktop;
  
  // Check if running in Node/SSR context
  if (typeof window === "undefined") {
    cachedIsDesktop = false;
    return false;
  }
  
  // Primary check: Tauri global
  if (window.__TAURI__ !== undefined) {
    cachedIsDesktop = true;
    return true;
  }
  
  // Secondary check: Tauri internals
  if ((window as any).__TAURI_INTERNALS__ !== undefined) {
    cachedIsDesktop = true;
    return true;
  }
  
  // Tertiary check: Look for Tauri-specific user agent
  if (navigator.userAgent.includes('Tauri')) {
    cachedIsDesktop = true;
    return true;
  }
  
  // Check if we're running on localhost:1420 (Tauri dev server)
  // This is a fallback for development
  if (window.location.hostname === 'localhost' && window.location.port === '1420') {
    // In dev, check if we can import Tauri API
    try {
      // Try to dynamically check for Tauri
      const hasTauri = !!(window as any).__TAURI__;
      cachedIsDesktop = hasTauri;
      return hasTauri;
    } catch {
      cachedIsDesktop = false;
      return false;
    }
  }
  
  cachedIsDesktop = false;
  return false;
}

// Open a URL outside the app. Desktop (Tauri) hands off to the system browser
// via the opener plugin; web opens a new tab. Used for OAuth authorize redirects
// and other external links so the executor webview never navigates away.
export async function openExternalUrl(url: string): Promise<void> {
  if (isDesktop()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const currencyFormatters = new Map<string, Intl.NumberFormat>();
const numberFormatters = new Map<number, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string): Intl.NumberFormat {
  const cached = currencyFormatters.get(currency);
  if (cached) return cached;
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  currencyFormatters.set(currency, fmt);
  return fmt;
}

function getNumberFormatter(decimals: number): Intl.NumberFormat {
  const cached = numberFormatters.get(decimals);
  if (cached) return cached;
  const fmt = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  numberFormatters.set(decimals, fmt);
  return fmt;
}

export function formatCurrency(value: number, currency: string = 'USD'): string {
  return getCurrencyFormatter(currency).format(value);
}

export function formatNumber(value: number, decimals: number = 4): string {
  return getNumberFormatter(decimals).format(value);
}
