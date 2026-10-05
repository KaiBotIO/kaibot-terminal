
import { API_BASE_URL } from './config';

interface APIClient {
  fetch: (url: string, options?: RequestInit) => Promise<Response>
  baseURL: string
}

const AUTH_TOKEN_KEY = 'auth_token';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Low-level fetch against the executor backend that prepends the API base URL
 * and attaches the session token. Use this instead of calling fetch with a
 * hand-built `${API_BASE_URL}${path}` so every request goes through the same
 * auth choke point. Does not throw on non-2xx — callers inspect `response.ok`.
 */
export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...options?.headers,
    },
  });
}

export function getAPI(): APIClient {
  const baseURL = API_BASE_URL;

  return {
    baseURL,
    fetch: async (url: string, options?: RequestInit) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      try {
        const response = await fetch(`${baseURL}${url}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
            ...options?.headers,
          },
          signal: controller.signal
        });
        clearTimeout(timeout);
        return response;
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Request timeout');
        }
        throw error;
      }
    }
  }
}

export const api = {
  baseURL: API_BASE_URL,
  
  get: async (url: string) => {
    const client = getAPI()
    try {
      const response = await client.fetch(url)
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      return response.json()
    } catch (error) {
      console.error(`API GET ${url} failed:`, error)
      throw error
    }
  },
  
  post: async (url: string, data: any) => {
    const client = getAPI()
    const response = await client.fetch(url, {
      method: 'POST',
      body: JSON.stringify(data)
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.json()
  },
  
  put: async (url: string, data: any) => {
    const client = getAPI()
    const response = await client.fetch(url, {
      method: 'PUT',
      body: JSON.stringify(data)
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.json()
  },
  
  delete: async (url: string) => {
    const client = getAPI()
    const response = await client.fetch(url, {
      method: 'DELETE'
    })
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    return response.json()
  }
}

declare global {
  interface Window {
    __TAURI__?: any
  }
}