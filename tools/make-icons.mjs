// Renders assets/icon*.svg into every size the app and the website need (PNGs + a multi-size Windows .ico).
// Usage: node tools/make-icons.mjs   (needs Playwright's Chromium, already installed in dev/CI images)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const write = (p, b) => { writeFileSync(new URL(p, root), b); console.log("wrote", p); };
const svg = read("assets/icon.svg").toString();
const maskable = read("assets/icon-maskable.svg").toString();

const browser = await chromium.launch();
const render = async (source, size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}" width="${size}" height="${size}" style="display:block"></body>`);
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
};

// Windows .ico = header + directory + embedded PNGs (supported since Vista)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(icoSizes.map((s) => render(svg, s)));
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const dir = icoSizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length;
  return e;
});

mkdirSync(new URL("apps/desktop/build/", root), { recursive: true });
write("apps/desktop/build/icon.ico", Buffer.concat([head, ...dir, ...pngs]));
write("apps/desktop/build/icon.png", await render(svg, 512));

for (const [file, source, size] of [
  ["apps/cloud/public/icon-192.png", svg, 192], ["apps/cloud/public/icon-180.png", svg, 180], ["apps/cloud/public/icon-512.png", svg, 512],
  ["apps/cloud/public/icon-maskable-512.png", maskable, 512],
]) write(file, await render(source, size));
write("apps/cloud/public/icon.svg", Buffer.from(svg));
write("apps/ui/public/icon.svg", Buffer.from(svg));
await browser.close();
