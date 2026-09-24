// Resize PNG screenshots to WebP using headless Chromium (no native image libs available).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.SHOTS_DIR || path.join(HERE, 'out');
const OUT = process.argv[2] || path.join(HERE, '../../assets/screenshots');
const MONTAGE = process.argv[3] === 'montage';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.png') && !f.startsWith('_'));
const thumbs = [];
for (const f of files) {
  const b64 = fs.readFileSync(path.join(SRC, f)).toString('base64');
  const res = await page.evaluate(
    async ({ b64, maxW }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = 'data:image/png;base64,' + b64;
      });
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const webp = c.toDataURL('image/webp', 0.82);
      const t = document.createElement('canvas');
      t.width = 320;
      t.height = Math.round((320 * img.height) / img.width);
      const tctx = t.getContext('2d');
      tctx.drawImage(img, 0, 0, t.width, t.height);
      return { webp, thumb: t.toDataURL('image/jpeg', 0.7), w: c.width, h: c.height };
    },
    { b64, maxW: f.startsWith('mobile') ? 780 : 1600 }
  );
  fs.writeFileSync(
    path.join(OUT, f.replace(/\.png$/, '.webp')),
    Buffer.from(res.webp.split(',')[1], 'base64')
  );
  thumbs.push({ name: f, thumb: res.thumb });
}
if (MONTAGE) {
  const cols = 4;
  const html =
    `<html><body style="margin:0;background:#fff;font:11px sans-serif"><div style="display:grid;grid-template-columns:repeat(${cols},320px);gap:6px;padding:6px">` +
    thumbs
      .map(
        t =>
          `<div><img src="${t.thumb}" style="width:320px;display:block;border:1px solid #ccc"><div style="text-align:center">${t.name}</div></div>`
      )
      .join('') +
    '</div></body></html>';
  await page.setContent(html);
  const rows = Math.ceil(thumbs.length / cols);
  await page.setViewportSize({ width: cols * 326 + 12, height: Math.min(rows * 235 + 12, 6000) });
  await page.screenshot({
    path: path.join(OUT, '_montage.jpg'),
    type: 'jpeg',
    quality: 80,
    fullPage: true
  });
}
await browser.close();
const total = fs
  .readdirSync(OUT)
  .filter(f => f.endsWith('.webp'))
  .reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`converted ${files.length} files, total ${(total / 1024 / 1024).toFixed(1)} MB`);
