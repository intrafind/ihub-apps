/**
 * The client must load pdf.js's LEGACY build, library and worker alike.
 *
 * Why: pdfjs-dist 6.x's modern build (`pdfjs-dist`, `pdfjs-dist/build/*`) calls
 * `Map.prototype.getOrInsertComputed` (TC39 "upsert"), which many current browsers do not
 * implement yet. Without it, encrypted PDFs fail to parse (worker side) and no page can be
 * rendered (main thread) — `TypeError: ...getOrInsertComputed is not a function`. The legacy
 * build (`pdfjs-dist/legacy/build/*`) bundles a core-js polyfill for it.
 *
 * A worker has its own global scope, so a polyfill on the main thread does not reach it: the
 * worker file has to be the legacy one as well, and library and worker must stay a pair.
 *
 * Three layers are pinned here:
 *  1. `loadPdfjs` returns the legacy library and points it at the bundled worker (behaviour).
 *  2. No client source imports a non-legacy pdfjs-dist entry (the worker `?url` import is
 *     invisible to the behavioural test, because jest maps every `?url` to one mock).
 *  3. The installed legacy files really install the polyfill, in the library and in the worker
 *     (guards a pdfjs-dist upgrade that stops shipping it; the modern files do not).
 *
 * pdf.js is ESM-only and cannot be loaded by jest, hence the mocks in (1) and the child Node
 * processes in (3).
 */
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(() => Promise.resolve({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(() => Promise.resolve({ features: [] }))
}));
// Distinguishable fake of the legacy library; the modern entries must never be requested.
jest.mock(
  'pdfjs-dist/legacy/build/pdf.mjs',
  () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn(), isLegacyBuild: true }),
  { virtual: true }
);
jest.mock(
  'pdfjs-dist',
  () => {
    throw new Error('the modern pdf.js build was loaded');
  },
  { virtual: true }
);
jest.mock(
  'pdfjs-dist/build/pdf.mjs',
  () => {
    throw new Error('the modern pdf.js build was loaded');
  },
  { virtual: true }
);

const { loadPdfjs } = require('../../../client/src/features/upload/utils/fileProcessing');

const repoRoot = path.resolve(__dirname, '../../..');
const clientSrc = path.join(repoRoot, 'client/src');
const pdfjsRoot = path.join(repoRoot, 'client/node_modules/pdfjs-dist');

const LEGACY_LIBRARY = 'pdfjs-dist/legacy/build/pdf.mjs';
const LEGACY_WORKER = 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

describe('loadPdfjs', () => {
  it('resolves the legacy library, never the modern one', async () => {
    const pdfjsLib = await loadPdfjs();
    expect(pdfjsLib.isLegacyBuild).toBe(true);
  });

  it('points the library at the locally bundled worker asset', async () => {
    const pdfjsLib = await loadPdfjs();
    // `?url` imports resolve to tests/config/fileUrlMock.js in jest.
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBe('/mocked-asset-url');
  });
});

/** All `.js`/`.jsx`/`.ts`/`.tsx` files below a directory. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every pdfjs-dist module specifier the client imports (static, dynamic, re-export, require),
 * without a `?query` suffix. Comments that merely mention the package are not matched: only
 * a quoted specifier right after `from`, `import`, `import(` or `require(` counts.
 */
function pdfjsSpecifiers() {
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](pdfjs-dist[^'"?]*)[^'"]*['"]/g;
  return sourceFiles(clientSrc).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map(match => ({
      file: path.relative(repoRoot, file),
      specifier: match[1]
    }))
  );
}

describe('client pdf.js imports', () => {
  it('imports the legacy library and the legacy worker as a pair', () => {
    const specifiers = pdfjsSpecifiers().map(({ specifier }) => specifier);
    expect(specifiers).toContain(LEGACY_LIBRARY);
    expect(specifiers).toContain(LEGACY_WORKER);
  });

  it('imports no pdfjs-dist entry outside the legacy build', () => {
    const modern = pdfjsSpecifiers().filter(
      ({ specifier }) => !specifier.startsWith('pdfjs-dist/legacy/')
    );
    expect(modern).toEqual([]);
  });
});

/**
 * Imports one pdfjs-dist file in a fresh Node process and reports which of the four
 * upsert methods (Map/WeakMap x getOrInsert/getOrInsertComputed) are missing before and after.
 * The methods are deleted first, so the check also means something on a Node that implements
 * them natively. A fresh process keeps it independent of anything else loaded in the jest
 * worker.
 */
function upsertMethodsAround(relativeFile) {
  const url = pathToFileURL(path.join(pdfjsRoot, relativeFile)).href;
  const script = `
    const missing = () => ['Map', 'WeakMap'].flatMap(ctor =>
      ['getOrInsert', 'getOrInsertComputed']
        .filter(method => typeof globalThis[ctor].prototype[method] !== 'function')
        .map(method => ctor + '.' + method));
    for (const ctor of ['Map', 'WeakMap']) {
      for (const method of ['getOrInsert', 'getOrInsertComputed']) {
        delete globalThis[ctor].prototype[method];
      }
    }
    const before = missing();
    await import(${JSON.stringify(url)});
    console.log(JSON.stringify({ before, after: missing() }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return JSON.parse(output.trim().split('\n').pop());
}

describe('installed pdfjs-dist legacy build', () => {
  it.each([
    ['library', 'legacy/build/pdf.mjs'],
    ['worker', 'legacy/build/pdf.worker.min.mjs']
  ])('installs the upsert polyfill by itself (%s)', (_name, file) => {
    const { before, after } = upsertMethodsAround(file);
    expect(before).toEqual([
      'Map.getOrInsert',
      'Map.getOrInsertComputed',
      'WeakMap.getOrInsert',
      'WeakMap.getOrInsertComputed'
    ]);
    expect(after).toEqual([]);
  });
});
