import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs separately; in production it serves this build.
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
  build: { target: "es2022", sourcemap: true },
});
