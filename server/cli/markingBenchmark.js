/**
 * `npm run test:marking-benchmark [-- --full] [--out report.json]` — runs the
 * EU AI Act marking robustness harness (issue #2574) outside the server, for
 * CI and nightly runs. Uses (and on a fresh checkout creates) the local
 * installation's signing certificate; TrustMark models are downloaded on
 * first use (~65 MB, see services/provenance/image/trustmarkModels.js) unless
 * `aiTransparency.images.trustmarkModelPath` points at a local copy.
 *
 * Exit code 1 when a check fails.
 *
 * @module cli/markingBenchmark
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runMarkingBenchmarkCLI(argv = []) {
  const full = argv.includes('--full');
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : null;
  const { setLogLevel } = await import('../utils/logger.js');
  setLogLevel('warn');
  const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
  await tokenStorageService.initializeEncryptionKey();
  const { ensureInstallationId } = await import('../services/provenance/installation.js');
  await ensureInstallationId();
  const { runMarkingBenchmark } =
    await import('../services/provenance/benchmark/MarkingBenchmark.js');
  const report = await runMarkingBenchmark({ quick: !full, trigger: 'cli' });
  const pct = v =>
    v === null || v === undefined ? '   —' : `${(v * 100).toFixed(0).padStart(3)}%`;
  console.log(
    `\nMarking benchmark ${report.id} (${full ? 'full' : 'quick'}) on ${report.environment.platform}\n`
  );
  for (const r of report.results) {
    console.log(
      `${r.status.padEnd(7)} ${r.technique.padEnd(20)} ${r.transform.padEnd(44)} TPR ${pct(r.tpr)}  FPR ${pct(r.fpr)}  n=${r.samples}${r.note ? `  (${r.note})` : ''}`
    );
  }
  console.log(
    `\n${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`
  );
  if (out) {
    await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${out}`);
  }
  return report.summary.failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMarkingBenchmarkCLI(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      console.error(error);
      process.exit(1);
    }
  );
}
