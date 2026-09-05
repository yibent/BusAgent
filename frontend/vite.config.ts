import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const backendTarget =
  process.env.BUSAGENT_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1/stt": {
        target: backendTarget,
        ws: true,
      },
      "/v1/robot": {
        target: backendTarget,
      },
    },
  },
});
