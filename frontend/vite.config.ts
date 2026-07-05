import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend port for the dev proxy; override with DURIN_BACKEND_PORT if you
// changed PORT in .env.
const backendPort = process.env.DURIN_BACKEND_PORT || "8400";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${backendPort}`,
    },
  },
});
