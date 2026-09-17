// server/tests/agent-planner-no-final-report.test.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(l, c, d) {
  if (!c) failures++;
  console.log(`${c ? '✅' : '❌'} ${l}`);
  if (!c && d) console.log('   ' + d);
}
function run() {
  const src = readFileSync(
    path.join(root, 'server/agents/profile/profileWorkflowSerializer.js'),
    'utf8'
  );
  // The DEFAULT_PLANNER_SYSTEM must instruct the planner NOT to emit a final
  // report / synthesis / compile task — the synthesize node owns composition.
  check(
    'canonical planner prompt forbids final-report tasks',
    /do not (emit|create|include).{0,80}(final report|synthesis|compile)/i.test(src) ||
      /synthesize node owns/i.test(src),
    'no no-final-report rule found in DEFAULT_PLANNER_SYSTEM'
  );
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
