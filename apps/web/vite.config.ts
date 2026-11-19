import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Preloads the two font files every page needs for its first paint (body text
 * and headings), so text renders in IBM Plex straight away instead of swapping
 * in after the stylesheet has been parsed.
 */
function preloadFonts(pattern: RegExp): Plugin {
  return {
    name: "marketlab:preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        return Object.keys(bundle ?? {})
          .filter((file) => pattern.test(file))
          .sort()
          .map((file) => ({
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              href: `/${file}`,
              crossorigin: "",
            },
            injectTo: "head" as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    preloadFonts(/ibm-plex-sans-latin-(400|600)-normal-[\w-]+\.woff2$/),
  ],
  server: {
    port: 5173,
    // In development the API runs separately; in production it serves this build.
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
  // The manifest lets the server preload a page's own chunk from its HTML
  // (see routePreloads in the API), instead of after the main bundle has run.
  build: { target: "es2022", sourcemap: true, manifest: true },
});
