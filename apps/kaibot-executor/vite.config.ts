import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const host = process.env.TAURI_DEV_HOST;
const backendPort = process.env.EXECUTOR_BACKEND_PORT || "8080";

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // resolve, not a hardcoded hoist path — layout differs between the
      // monorepo and the public mirror workspace
      'react': path.dirname(require.resolve('react/package.json')),
      'react-dom': path.dirname(require.resolve('react-dom/package.json')),
    },
    dedupe: ['react', 'react-dom'],
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        // /api/ws/notifications upgrades to a WebSocket — proxy that too.
        ws: true,
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
