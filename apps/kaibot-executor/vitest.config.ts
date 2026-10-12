import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// Component tests only. Keep this fully separate from `bun test` (node-backend
// + plain .test.ts unit tests): files here use the `.vitest.tsx` suffix so
// bun's own test discovery (which matches on ".test"/".spec") never touches
// them, and `include` below keeps this runner from picking up bun's files.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/vitest-setup.ts'],
    include: ['src/**/*.vitest.{ts,tsx}'],
  },
});
