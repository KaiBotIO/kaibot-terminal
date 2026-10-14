import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

export interface TrpcClientConfigOptions {
  apiUrl: string;
  // Bearer token to use when no admin token is stored. The Studio embed
  // hand-off hands the framed app a session token because the cross-site
  // cookie may never arrive (apps/frontend/src/lib/embed-session.ts).
  fallbackAuthToken?: () => string | null;
}

export const createTrpcClientConfig = ({ apiUrl, fallbackAuthToken }: TrpcClientConfigOptions) => ({
  links: [
    httpBatchLink({
      url: apiUrl,
      transformer: superjson,
      fetch(url, options) {
        return fetch(url, {
          ...options,
          credentials: 'include',
        });
      },
      headers() {
        const token = localStorage.getItem('token') ?? fallbackAuthToken?.() ?? null;
        return {
          Authorization: token ? `Bearer ${token}` : '',
        };
      },
    }),
  ],
});