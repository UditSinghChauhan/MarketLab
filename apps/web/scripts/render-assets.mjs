/**
 * Renders the images in public/ that are derived from the product itself:
 *
 *   og.png                 link-preview image: a real terminal screenshot
 *                          composed with the name and pitch (scripts/og.html)
 *   apple-touch-icon.png   180 px home-screen icon
 *   icon-192.png, icon-512.png   web manifest icons
 *
 * Usage: start the app (`npm run build && npm start`, or the dev servers), then
 *   BASE_URL=http://localhost:8080 npm run assets -w @marketlab/web
 * Set CHROME_PATH to use an installed Chrome instead of Playwright's browser.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const fonts = path.resolve(here, "../../../node_modules/@fontsource/ibm-plex-sans/files");
const baseUrl = process.env.BASE_URL ?? "http://localhost:8080";

const dataUrl = async (file, type) =>
  `data:${type};base64,${(await readFile(file)).toString("base64")}`;

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M2 6h2v14H2zM5 10h2v10H5zM8 14h2v6H8z" fill="#0F7A50"/>
  <path d="M14 14h2v6h-2zM17 10h2v10h-2zM20 6h2v14h-2z" fill="#C8323A"/>
  <path d="M12 3v18" stroke="#121A26" stroke-width="1.25" stroke-dasharray="1.5 1.5"/>
</svg>`;

// CHROME_PATH points at an existing Chrome when Playwright's own browser is not installed.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
try {
  // 1. A real screenshot of the terminal, with live data and the guide dismissed.
  const terminal = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  await terminal.addInitScript(() => {
    localStorage.setItem("marketlab.guide", "done");
  });
  await terminal.goto(`${baseUrl}/terminal/ORBT`);
  await terminal.getByRole("status").filter({ hasText: "Live" }).waitFor();
  await terminal.getByRole("img", { name: /Price chart/ }).waitFor();
  await terminal.waitForTimeout(1_500);
  const screenshot = await terminal.screenshot({ type: "png" });
  await terminal.close();

  // 2. The link-preview image.
  const template = await readFile(path.join(here, "og.html"), "utf8");
  const html = template
    .replace(
      "{{font400}}",
      await dataUrl(path.join(fonts, "ibm-plex-sans-latin-400-normal.woff2"), "font/woff2"),
    )
    .replace(
      "{{font600}}",
      await dataUrl(path.join(fonts, "ibm-plex-sans-latin-600-normal.woff2"), "font/woff2"),
    )
    .replace("{{mark}}", MARK)
    .replace("{{screenshot}}", `data:image/png;base64,${screenshot.toString("base64")}`);
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.setContent(html, { waitUntil: "load" });
  await og.waitForFunction("document.fonts.status === 'loaded'");
  await og.screenshot({ path: path.join(publicDir, "og.png"), type: "png" });
  await og.close();

  // 3. Icons, drawn from the favicon. The mark sits inside the maskable safe zone.
  const favicon = await readFile(path.join(publicDir, "favicon.svg"), "utf8");
  const inner = favicon.replace(/<rect[^>]*\/>/, "");
  for (const [file, size] of [
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ]) {
    const icon = await browser.newPage({ viewport: { width: size, height: size } });
    await icon.setContent(
      `<body style="margin:0;background:#121820;display:grid;place-items:center;height:100vh">
         <div style="width:66%;height:66%">${inner.replace("<svg ", '<svg width="100%" height="100%" ')}</div>
       </body>`,
    );
    await icon.screenshot({ path: path.join(publicDir, file), type: "png" });
    await icon.close();
  }
  console.log(`Rendered og.png and icons into ${publicDir}`);
} finally {
  await browser.close();
}
