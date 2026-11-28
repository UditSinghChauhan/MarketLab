/**
 * Renders the images in public/ that are derived from the product itself:
 *
 *   og.png                 link-preview image: a real terminal screenshot
 *                          composed with the name and pitch (scripts/og.html)
 *   apple-touch-icon.png   180 px home-screen icon
 *   icon-192.png, icon-512.png   web manifest icons
 *   tour/*.webp            the landing page's product tour: terminal,
 *                          inspector and verified replay, at two widths,
 *                          plus a phone crop of each (tour/*-phone-*.webp)
 *
 * Usage: start the app (`npm run build && npm start`, or the dev servers), then
 *   BASE_URL=http://localhost:8080 npm run assets -w @marketlab/web
 * Set CHROME_PATH to use an installed Chrome instead of Playwright's browser.
 */

/* global document, window, HTMLElement, Image -- used only inside page.evaluate, which runs in the browser */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const fonts = path.resolve(here, "../../../node_modules/@fontsource/ibm-plex-sans/files");
const baseUrl = process.env.BASE_URL ?? "http://localhost:8080";
/** Widths of each tour image; the landing page lists both in `srcset`. */
const TOUR_WIDTHS = [1120, 2240];
/**
 * The phone crops: a 400 × 600 CSS px region of the product at a phone's width,
 * so its text shows at about its real size on a phone. Rendered at 3x.
 */
const PHONE = { width: 400, height: 600, scale: 3 };
const PHONE_WIDTHS = [800, 1200];

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

  // 4. The landing page's product tour: the terminal, the inspector tracing an
  //    order, and a finished verified replay, each in two widths of WebP.
  await renderTour(browser);
  await renderPhoneTour(browser);
  console.log(`Rendered og.png, icons and tour images into ${publicDir}`);
} finally {
  await browser.close();
}

async function renderTour(browser) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  await page.addInitScript(() => localStorage.setItem("marketlab.guide", "done"));
  const shots = {};

  await page.goto(`${baseUrl}/terminal/ORBT`);
  await page.getByRole("img", { name: /Price chart/ }).waitFor();
  const buy = page.getByRole("button", { name: /^Buy 10 ORBT/ });
  // The ticket enables its button once the book and the account have loaded.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent?.startsWith("Buy 10 ORBT") && !b.disabled,
    ),
  );
  await buy.click();
  await page.getByText("Bought 10 ORBT").waitFor();
  await page.waitForTimeout(1_500);
  shots.terminal = await page.screenshot({ type: "png" });

  await page.keyboard.press("i");
  await page
    .getByRole("dialog", { name: "Engine inspector" })
    .getByText("Matched by the engine")
    .waitFor();
  // The dialog focuses its Close button for keyboard users; a still image reads better without the ring.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(500);
  shots.inspector = await page.screenshot({ type: "png" });

  await page.goto(`${baseUrl}/replay`);
  await page
    .getByText(/Your browser replayed [\d,]+ engine commands/)
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1_000);
  shots.replay = await page.screenshot({ type: "png" });

  await writeWebp(browser, shots, TOUR_WIDTHS, "");
  await page.close();
}

/**
 * The tour on a phone: the full terminal at 1280 px would be unreadable at
 * 340 px wide, so each tab gets a crop of the product at a phone's own width,
 * all in one frame so switching tabs never changes the image's height.
 */
async function renderPhoneTour(browser) {
  const page = await browser.newPage({
    viewport: { width: PHONE.width, height: 900 },
    deviceScaleFactor: PHONE.scale,
    isMobile: true,
    hasTouch: true,
  });
  await page.addInitScript(() => localStorage.setItem("marketlab.guide", "done"));
  /** The frame, from `top` (page px) down, at the page's full width. */
  const crop = async (top) => {
    const y = await page.evaluate((top) => top + window.scrollY, top);
    return page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y, width: PHONE.width, height: PHONE.height },
    });
  };
  const shots = {};

  // The ticket, after a market buy, and the top of the book under it.
  await page.goto(`${baseUrl}/terminal/ORBT`);
  await page.getByRole("img", { name: /Price chart/ }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent?.startsWith("Buy 10 ORBT") && !b.disabled,
    ),
  );
  await page.getByRole("button", { name: /^Buy 10 ORBT/ }).click();
  await page.getByText("Bought 10 ORBT").waitFor();
  await page.waitForTimeout(1_500);
  const ticket = page.getByRole("region", { name: "Place an order" });
  await ticket.scrollIntoViewIfNeeded();
  shots.terminal = await crop((await ticket.boundingBox()).y);

  // The inspector fills a phone's screen; the crop is its top: the request path.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: /^Inspector/ }).click();
  const inspector = page.getByRole("dialog", { name: "Engine inspector" });
  await inspector.getByText("Matched by the engine").waitFor();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(500);
  shots.inspector = await crop((await inspector.boundingBox()).y);

  // The replay's verdict and the replayed chart under it, below the header.
  await page.goto(`${baseUrl}/replay`);
  await page
    .getByText(/Your browser replayed [\d,]+ engine commands/)
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1_000);
  shots.replay = await crop((await page.getByRole("banner").boundingBox()).height);

  await writeWebp(browser, shots, PHONE_WIDTHS, "-phone");
  await page.close();
}

/**
 * Chrome encodes WebP itself, so no image library is needed: draw each
 * screenshot onto a canvas at the target width and export it.
 */
async function writeWebp(browser, shots, widths, suffix) {
  await mkdir(path.join(publicDir, "tour"), { recursive: true });
  const encoder = await browser.newPage();
  for (const [name, png] of Object.entries(shots)) {
    for (const width of widths) {
      const base64 = await encoder.evaluate(
        async ({ src, width }) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = Math.round((image.height * width) / image.width);
          const context = canvas.getContext("2d");
          context.imageSmoothingQuality = "high";
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/webp", 0.86).split(",")[1];
        },
        { src: `data:image/png;base64,${png.toString("base64")}`, width },
      );
      await writeFile(
        path.join(publicDir, "tour", `${name}${suffix}-${String(width)}.webp`),
        Buffer.from(base64, "base64"),
      );
    }
  }
  await encoder.close();
}
