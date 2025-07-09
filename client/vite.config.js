import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: "../",
  server: {
    proxy: {
      "/api/": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/s/": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
