import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget =
  process.env.BUSAGENT_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
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
