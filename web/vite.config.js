import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so it's reachable from outside the container
    port: 5173,
    // The browser calls /api/... on the same origin (no CORS needed);
    // Vite forwards it to the api container. "api" is the compose service name.
    proxy: { "/api": "http://api:4000" },
    // File change events don't cross Docker bind mounts on Windows/macOS, so poll.
    watch: { usePolling: true },
  },
});
