import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

export interface TrpcClientConfigOptions {
  apiUrl: string;
}

export const createTrpcClientConfig = ({ apiUrl }: TrpcClientConfigOptions) => ({
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
        const token = localStorage.getItem('token');
        return {
          Authorization: token ? `Bearer ${token}` : '',
        };
      },
    }),
  ],
});