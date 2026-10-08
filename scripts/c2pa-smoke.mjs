#!/usr/bin/env node
/**
 * C2PA smoke test (issue #2568): on this platform, generate an installation
 * CA, sign a PNG with c2pa-node, verify it (Valid without the anchor, Trusted
 * with it), and round-trip a TrustMark watermark. Run by
 * `.github/workflows/ai-provenance.yml` on Linux, macOS and Windows.
 *
 * Usage: node scripts/c2pa-smoke.mjs [--no-trustmark]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = rel => import(pathToFileURL(path.join(root, 'server', rel)).href);
const { DIGITAL_SOURCE_TYPES } = await import(
  pathToFileURL(path.join(root, 'shared', 'aiTransparency.js')).href
);

const x509 = await load('services/provenance/signing/x509.js');
const c2pa = await load('services/provenance/signing/c2pa.js');
const formats = await load('services/provenance/image/imageFormats.js');

const fail = message => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

if (!(await c2pa.isC2paAvailable())) fail(`c2pa-node does not load here: ${c2pa.c2paLoadError()}`);
const g = await x509.generateInstallationCertificate({ organization: 'Smoke Test' });
const width = 256;
const rgb = Buffer.alloc(width * width * 3);
for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) % 251;
const png = formats.encodeRgb({ width, height: width, rgb }, 'image/png');
const signed = await c2pa.signAsset(
  png,
  'image/png',
  {
    claim_generator_info: [{ name: 'iHub Apps smoke test', version: '1' }],
    title: 'smoke.png',
    format: 'image/png',
    assertions: [
      {
        label: 'c2pa.actions',
        data: {
          actions: [
            {
              action: 'c2pa.created',
              digitalSourceType: DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia
            }
          ]
        }
      }
    ]
  },
  { chainPem: g.chainPem, keyPem: g.keyPem, alg: 'es256' }
);
const untrusted = await c2pa.readAsset(signed, 'image/png');
if (untrusted.validationState !== 'Valid') fail(`expected Valid, got ${untrusted.validationState}`);
const trusted = await c2pa.readAsset(signed, 'image/png', { trustAnchors: [g.rootPem] });
if (trusted.validationState !== 'Trusted') fail(`expected Trusted, got ${trusted.validationState}`);
console.log(`OK c2pa sign + verify on ${process.platform}-${process.arch}`);

if (!process.argv.includes('--no-trustmark')) {
  const c2paModule = await c2pa.loadC2pa();
  const modelPath =
    process.env.TRUSTMARK_MODEL_PATH || path.join(root, '.cache', 'trustmark-models');
  const tm = await c2paModule.Trustmark.newTrustmark({ variant: 'P', version: 'BCH_5', modelPath });
  const bits = '1'.repeat(30) + '0'.repeat(31);
  const out = await tm.encode(png, 0.95, bits);
  const marked = formats.encodeRgb({ width, height: width, rgb: out }, 'image/png');
  const decoded = await tm.decode(marked);
  if (decoded !== bits) fail('TrustMark payload did not round-trip');
  console.log('OK trustmark encode + decode');
}
