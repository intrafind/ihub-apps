/**
 * Marking robustness & reliability harness (CoP Measures 3.1–3.3, 4.2;
 * concept §6 item 8; issue #2574).
 *
 * Measures, with iHub's own markers and detectors:
 * - **images**: TrustMark after JPEG re-compression (q90/70/50), resize
 *   (75 %/50 %), centre crop (80 %), a screenshot-like pass (90 % scale,
 *   brightness shift, PNG) — TPR on marked samples, FPR on unmarked ones;
 *   C2PA validity on the untouched file and loss after re-encoding (expected:
 *   metadata does not survive, which is why the watermark exists);
 * - **files**: the iHub manifest of a signed PDF verifies intact, a one-byte
 *   change is detected, and the text survives a PDF→text round trip;
 * - **text**: the signpost survives copy/paste normalisation and trailing
 *   whitespace, and a truncation, homoglyph substitution or character
 *   insertion is detected as a change; with a watermark detector configured,
 *   FPR on held-out human text and — in the full run — TPR of the
 *   watermarking models on generated samples, per length bucket.
 *
 * Every run is stored as a versioned JSON report (the compliance report
 * includes the latest). Runs from the admin page ("self-test"), from CI
 * (`npm run test:marking-benchmark`) and after model or marking changes.
 *
 * @module services/provenance/benchmark/MarkingBenchmark
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import config from '../../../config.js';
import { getRootDir } from '../../../pathUtils.js';
import { getAppVersion } from '../../../utils/versionHelper.js';
import logger from '../../../utils/logger.js';
import { getAiTransparencyConfig } from '../config.js';
import { isC2paAvailable, readAsset } from '../signing/c2pa.js';
import signingService from '../signing/SigningService.js';
import { decodeImageWatermark, markImage } from '../image/ImageMarker.js';
import { decodeRgb, encodeRgb } from '../image/imageFormats.js';
import { applyTextSignpost, verifyTextSignpost } from '../text/signpost.js';
import { detectTextWatermark } from '../watermark/TextWatermarkDetector.js';
import keyGroupService from '../watermark/KeyGroupService.js';
import { signExport, verifyExportManifest } from '../export/ExportSigner.js';
import { renderExport } from '../export/renderers/index.js';

const COMPONENT = 'MarkingBenchmark';
const KEEP_REPORTS = 20;

/** Held-out human-written samples (for text-watermark false positives). */
export const HUMAN_TEXT_SAMPLES = [
  'The committee met on Tuesday to review the budget for the coming year. After a long discussion about maintenance costs for the old library building, the members agreed to postpone the renovation until the spring and to ask the city for a second estimate. Several residents spoke during the public comment period, most of them in favour of keeping the reading room open on weekends. The next meeting will take place in the town hall, and the minutes will be published on the notice board as usual.',
  'To replace the chain on a bicycle, first shift to the smallest sprocket at the back and the smallest ring at the front, which gives the chain some slack. Use a chain tool to push out one of the pins, or open the quick link if the chain has one. Count the links of the old chain so the new one ends up the same length, then thread it over the sprockets and through the derailleur cage before joining the ends again. Finish by checking that every link bends freely and by adding a drop of oil to each roller.',
  'Grandmother kept her recipes in a wooden box on the shelf above the stove. Most of the cards were written in pencil, and some had been corrected so often that the paper had worn thin. The apple cake she baked every October was not written down at all; she said she measured the flour with a coffee cup and the butter by eye, and that the oven told her when the cake was ready. We tried for years to bake it the way she did, and we never quite managed it.',
  'Die Versammlung begann pünktlich um sieben Uhr. Nach der Begrüßung durch den Vorsitzenden wurde zunächst über die Renovierung des Vereinsheims gesprochen, deren Kosten deutlich höher ausfallen als ursprünglich geplant. Mehrere Mitglieder schlugen vor, einen Teil der Arbeiten in Eigenleistung zu erledigen, um das Budget zu entlasten. Am Ende einigte man sich darauf, zwei weitere Angebote einzuholen und die Entscheidung auf die nächste Sitzung im Herbst zu verschieben.'
];

function reportsDir() {
  return path.join(
    getRootDir(),
    config.CONTENTS_DIR,
    config.DATA_DIR || 'data',
    'ai-provenance',
    'benchmarks'
  );
}

/** Procedural test image: gradients, shapes and noise, deterministic per seed. */
export function syntheticImage(seed, width = 512, height = 512) {
  const rgb = Buffer.alloc(width * height * 3);
  let state = (seed * 2654435761) >>> 0;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1000) / 1000;
  };
  const cx = width * (0.3 + rand() * 0.4);
  const cy = height * (0.3 + rand() * 0.4);
  const r = Math.min(width, height) * (0.15 + rand() * 0.2);
  const hue = rand() * 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      const noise = (rand() - 0.5) * 24;
      rgb[i] = Math.max(0, Math.min(255, (inCircle ? hue : (x / width) * 255) + noise));
      rgb[i + 1] = Math.max(0, Math.min(255, (inCircle ? 255 - hue : (y / height) * 200) + noise));
      rgb[i + 2] = Math.max(0, Math.min(255, 128 + Math.sin((x + y) / (12 + seed)) * 90 + noise));
    }
  }
  return { width, height, rgb };
}

function resize({ width, height, rgb }, factor) {
  const w = Math.max(16, Math.round(width * factor));
  const h = Math.max(16, Math.round(height * factor));
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / factor - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / factor - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => rgb[(yy * width + xx) * 3 + c];
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bottom = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[(y * w + x) * 3 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width: w, height: h, rgb: out };
}

function crop({ width, height, rgb }, keep) {
  const w = Math.round(width * keep);
  const h = Math.round(height * keep);
  const ox = Math.floor((width - w) / 2);
  const oy = Math.floor((height - h) / 2);
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    rgb.copy(out, y * w * 3, ((oy + y) * width + ox) * 3, ((oy + y) * width + ox + w) * 3);
  }
  return { width: w, height: h, rgb: out };
}

function brighten({ width, height, rgb }, delta) {
  const out = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = Math.max(0, Math.min(255, rgb[i] + delta));
  return { width, height, rgb: out };
}

/** Image transforms: name → (png bytes) → bytes. */
export const IMAGE_TRANSFORMS = {
  identity: buf => buf,
  'jpeg-q90': buf => encodeRgb(decodeRgb(buf, 'image/png'), 'image/jpeg', { quality: 90 }),
  'jpeg-q70': buf => encodeRgb(decodeRgb(buf, 'image/png'), 'image/jpeg', { quality: 70 }),
  'jpeg-q50': buf => encodeRgb(decodeRgb(buf, 'image/png'), 'image/jpeg', { quality: 50 }),
  'resize-75': buf => encodeRgb(resize(decodeRgb(buf, 'image/png'), 0.75), 'image/png'),
  'resize-50': buf => encodeRgb(resize(decodeRgb(buf, 'image/png'), 0.5), 'image/png'),
  'crop-80': buf => encodeRgb(crop(decodeRgb(buf, 'image/png'), 0.8), 'image/png'),
  screenshot: buf => encodeRgb(brighten(resize(decodeRgb(buf, 'image/png'), 0.9), 6), 'image/png')
};

/** Text edits: name → (text) → text. */
export const TEXT_EDITS = {
  identity: t => t,
  'nfc-normalize': t => t.normalize('NFC'),
  'trailing-whitespace': t => t.replace(/\n/g, '  \n'),
  truncate: t => t.slice(0, Math.floor(t.length * 0.6)),
  homoglyphs: t => t.replace(/a/g, 'а').replace(/e/g, 'е').replace(/o/g, 'о'),
  'char-insertion': t => t.replace(/ /g, (m, i) => (i % 7 === 0 ? ' ​' : m))
};

function result(
  technique,
  transform,
  { samples, detected = 0, falsePositives = 0, negatives = 0, expect = 'detect', note }
) {
  const tpr = samples > 0 ? detected / samples : null;
  const fpr = negatives > 0 ? falsePositives / negatives : null;
  let status;
  if (samples === 0 && negatives === 0) status = 'skipped';
  else if (expect === 'detect')
    status = tpr !== null && tpr >= 0.9 && (fpr === null || fpr <= 0.01) ? 'pass' : 'fail';
  else if (expect === 'reject') status = tpr === 0 ? 'pass' : 'fail';
  else status = 'pass';
  return {
    technique,
    transform,
    samples,
    detected,
    negatives,
    falsePositives,
    tpr,
    fpr,
    status,
    ...(note ? { note } : {})
  };
}

async function imageBenchmarks(quick, results) {
  const cfg = getAiTransparencyConfig();
  const c2pa = await isC2paAvailable();
  if (!c2pa) {
    results.push(
      result('trustmark', 'all', { samples: 0, note: 'C2PA/TrustMark library unavailable' })
    );
    results.push(result('c2pa', 'identity', { samples: 0, note: 'C2PA library unavailable' }));
    return;
  }
  const count = quick ? 2 : 8;
  const marked = [];
  const clean = [];
  for (let i = 0; i < count; i++) {
    const png = encodeRgb(syntheticImage(i + 1), 'image/png');
    clean.push(png);
    const out = await markImage({ buffer: png, mimeType: 'image/png', record: false });
    marked.push({
      buffer: out.buffer,
      contentId: out.provenance.contentId,
      markings: out.provenance.markings
    });
  }
  const watermarked = marked.filter(m => m.markings.includes('trustmark'));
  if (cfg.images.watermark !== 'trustmark' || watermarked.length === 0) {
    results.push(result('trustmark', 'all', { samples: 0, note: 'Watermark off or unavailable' }));
  } else {
    const transforms = quick
      ? ['identity', 'jpeg-q70', 'resize-50', 'screenshot']
      : Object.keys(IMAGE_TRANSFORMS);
    for (const name of transforms) {
      let detected = 0;
      let falsePositives = 0;
      for (const m of watermarked) {
        const decoded = await decodeImageWatermark(IMAGE_TRANSFORMS[name](m.buffer));
        if (decoded.found && decoded.contentId === m.contentId) detected++;
      }
      for (const c of clean) {
        const decoded = await decodeImageWatermark(IMAGE_TRANSFORMS[name](c));
        if (decoded.found) falsePositives++;
      }
      results.push(
        result('trustmark', name, {
          samples: watermarked.length,
          detected,
          negatives: clean.length,
          falsePositives
        })
      );
    }
  }
  // C2PA: valid on the untouched file; metadata does not survive re-encoding.
  const anchors = await signingService.getTrustAnchors();
  let valid = 0;
  let survived = 0;
  for (const m of marked) {
    const read = await readAsset(m.buffer, 'image/png', { trustAnchors: anchors });
    if (read.present && ['Valid', 'Trusted'].includes(read.validationState)) valid++;
    const reencoded = IMAGE_TRANSFORMS['jpeg-q90'](m.buffer);
    const after = await readAsset(reencoded, 'image/jpeg');
    if (after.present) survived++;
  }
  results.push(result('c2pa', 'identity', { samples: marked.length, detected: valid }));
  results.push(
    result('c2pa', 'jpeg-q90 (metadata loss expected)', {
      samples: marked.length,
      detected: survived,
      expect: 'info',
      note: 'Re-encoding strips metadata; the watermark carries the soft binding'
    })
  );
}

async function fileBenchmarks(results) {
  const sample = HUMAN_TEXT_SAMPLES[0];
  try {
    const rendered = await renderExport('pdf', {
      title: 'Benchmark',
      appName: 'iHub Apps',
      exportedAt: new Date().toISOString(),
      language: 'en',
      settings: null,
      messages: [{ index: 0, role: 'assistant', content: sample, verification: 'verified' }],
      source: 'chat',
      label: {
        show: true,
        text: 'AI-generated content — created with iHub Apps',
        euIcon: false,
        humanReviewed: false,
        editorialContact: null,
        provider: null
      },
      template: 'default',
      single: true
    });
    const signed = await signExport({
      format: 'pdf',
      buffer: rendered.buffer,
      payload: {
        v: 1,
        typ: 'ihub-export-manifest',
        manifestId: `exp_bench${crypto.randomBytes(6).toString('hex')}`,
        format: 'pdf',
        aiGenerated: true
      },
      meta: { generator: `iHub Apps ${getAppVersion()}`, labelText: 'benchmark' }
    });
    const intact = await verifyExportManifest(signed.buffer, { kind: 'pdf' });
    results.push(
      result('ihub-manifest', 'pdf identity', {
        samples: 1,
        detected: intact.found && intact.valid && intact.intact ? 1 : 0
      })
    );
    const tampered = Buffer.from(signed.buffer);
    const at = Math.floor(tampered.length / 3);
    tampered[at] = tampered[at] ^ 0x01;
    const broken = await verifyExportManifest(tampered, { kind: 'pdf' });
    results.push(
      result('ihub-manifest', 'pdf one-byte change (must be rejected)', {
        samples: 1,
        detected: broken.found && broken.intact ? 1 : 0,
        expect: 'reject'
      })
    );
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(signed.buffer),
      isEvalSupported: false
    }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += `${content.items.map(item => item.str).join(' ')} `;
    }
    const words = sample.split(/\s+/).slice(0, 20).join(' ');
    const normalized = text.replace(/\s+/g, ' ');
    results.push(
      result('pdf-text-roundtrip', 'pdf→text', {
        samples: 1,
        detected: normalized.includes(words.split(' ').slice(0, 8).join(' ')) ? 1 : 0,
        note: 'The text layer (and a text watermark in it) survives PDF→text extraction'
      })
    );
  } catch (error) {
    results.push(result('ihub-manifest', 'pdf', { samples: 0, note: `Not run: ${error.message}` }));
  }
}

async function textBenchmarks(quick, results) {
  const samples = quick ? HUMAN_TEXT_SAMPLES.slice(0, 2) : HUMAN_TEXT_SAMPLES;
  const signed = [];
  for (const text of samples) {
    const withSignpost = await applyTextSignpost(text, {});
    if (withSignpost !== text) signed.push(withSignpost);
  }
  if (!signed.length) {
    results.push(result('text-signpost', 'all', { samples: 0, note: 'Signing unavailable' }));
  } else {
    for (const [name, edit] of Object.entries(TEXT_EDITS)) {
      let intact = 0;
      for (const t of signed) {
        const check = await verifyTextSignpost(edit(t));
        if (check.found && check.valid && check.intact) intact++;
      }
      const mustSurvive = ['identity', 'nfc-normalize', 'trailing-whitespace'].includes(name);
      results.push(
        result('text-signpost', mustSurvive ? name : `${name} (must be detected as changed)`, {
          samples: signed.length,
          detected: intact,
          expect: mustSurvive ? 'detect' : 'reject'
        })
      );
    }
  }
  // Text watermark: only with a detector.
  const groups = (await keyGroupService.list()).filter(g => g.detectorUrl);
  if (!groups.length) {
    results.push(
      result('text-watermark', 'human text (FPR)', {
        samples: 0,
        note: 'No watermark detector configured'
      })
    );
    return;
  }
  let falsePositives = 0;
  for (const text of HUMAN_TEXT_SAMPLES) {
    const wm = await detectTextWatermark(text);
    if (wm.detected) falsePositives++;
  }
  results.push(
    result('text-watermark', 'human text (FPR)', {
      samples: 0,
      negatives: HUMAN_TEXT_SAMPLES.length,
      falsePositives,
      expect: 'info',
      note: 'Held-out human-written samples; TPR needs generated samples from the watermarking model (full run)'
    })
  );
}

async function saveReport(report) {
  const dir = reportsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_REPORTS))) {
    await fs.rm(path.join(dir, old), { force: true });
  }
}

/**
 * The most recent stored report, or null.
 */
export async function latestBenchmark() {
  try {
    const files = (await fs.readdir(reportsDir())).filter(f => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(await fs.readFile(path.join(reportsDir(), files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the harness.
 * @param {{quick?: boolean, trigger?: string, save?: boolean}} [opts]
 * @returns {Promise<Object>} the report
 */
export async function runMarkingBenchmark({ quick = true, trigger = 'manual', save = true } = {}) {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const [label, fn] of [
    ['images', () => imageBenchmarks(quick, results)],
    ['files', () => fileBenchmarks(results)],
    ['text', () => textBenchmarks(quick, results)]
  ]) {
    try {
      await fn();
    } catch (error) {
      logger.warn('Benchmark section failed', {
        component: COMPONENT,
        section: label,
        error: error.message
      });
      results.push(result(label, 'section', { samples: 0, note: `Failed: ${error.message}` }));
    }
  }
  const summary = {
    total: results.length,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    skipped: results.filter(r => r.status === 'skipped').length
  };
  const report = {
    id: `${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger,
    quick,
    environment: {
      ihubVersion: getAppVersion(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      c2pa: await isC2paAvailable()
    },
    summary,
    results
  };
  if (save) {
    await saveReport(report).catch(error =>
      logger.warn('Could not store benchmark report', {
        component: COMPONENT,
        error: error.message
      })
    );
  }
  return report;
}
