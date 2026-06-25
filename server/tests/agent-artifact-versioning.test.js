// Plain-node test (node server/tests/agent-artifact-versioning.test.js).
// The synthesizer re-runs once per adversarial-review round; it used to
// OVERWRITE the same primary artifact (result.md) each round, so only the
// final compose survived. It now versions like the primary-producer path:
// result.md, result.v2.md, result.v3.md … This tests the shared pure helper.
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

function run() {
  const e = new PromptNodeExecutor();

  // First write keeps the base name; later writes increment the version.
  check('round 0 → base name', e._versionedArtifactName('result.md', 0) === 'result.md');
  check('round 1 → .v2', e._versionedArtifactName('result.md', 1) === 'result.v2.md');
  check('round 2 → .v3', e._versionedArtifactName('result.md', 2) === 'result.v3.md');

  // Version is inserted before the LAST dot (handles multi-dot names).
  check('multi-dot name', e._versionedArtifactName('a.b.md', 1) === 'a.b.v2.md');

  // No extension → append the version suffix.
  check('no extension', e._versionedArtifactName('report', 1) === 'report.v2');

  // Defensive: falsy / <1 prior count returns the base name unchanged.
  check('null priorCount → base', e._versionedArtifactName('result.md', null) === 'result.md');
  check('undefined priorCount → base', e._versionedArtifactName('result.md', undefined) === 'result.md');

  // Counter semantics: priorCount is "how many already written", so a fresh
  // run (0) writes result.md and bumps the counter to 1; the next compose
  // (priorCount 1) writes result.v2.md — i.e. distinct names every round.
  const names = [0, 1, 2, 3].map(c => e._versionedArtifactName('result.md', c));
  check('four rounds yield four distinct names', new Set(names).size === 4, names.join(', '));

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
