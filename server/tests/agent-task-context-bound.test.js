// Plain-node test (node server/tests/agent-task-context-bound.test.js).
//
// Regression for runaway input-token growth in phased agent runs
// (run wf-exec-f33f80fc burned 3.29M input tokens). Every non-synthesizer
// sub-task baked the ENTIRE accumulated `_taskResults` corpus (22 results,
// ~283KB / ~70K tokens) into its prompt via {{previousTaskResults}}, then the
// tool loop re-sent that seed on every iteration (×8). A one-fact verification
// task cost 481K input tokens.
//
// Fix: `_formatPreviousTaskResults(state, opts)` accepts a budget. Worker tasks
// pass a bound (cap result count + truncate bodies); the synthesizer passes no
// bound (it must see the full corpus to compose the report). buildMessages
// chooses the budget from `config._isSynthesizer`.
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

function makeState(n, bodyChars) {
  const _taskResults = {};
  for (let i = 0; i < n; i++) {
    _taskResults[`task_${i}`] = {
      taskId: `task_${i}`,
      title: `Task ${i}`,
      content: `B${i}`.repeat(bodyChars / 2), // ~bodyChars long, distinct per task
      completedAt: `2026-06-29T10:${String(i).padStart(2, '0')}:00.000Z`
    };
  }
  return { data: { _taskResults } };
}

function run() {
  const e = new PromptNodeExecutor();

  // ---- Unbounded (synthesizer path) preserves existing behavior ----
  const state = makeState(22, 12000); // 22 results × ~12KB ≈ 264KB
  const unbounded = e._formatPreviousTaskResults(state);
  check('unbounded includes every task', /Task 0\b/.test(unbounded) && /Task 21\b/.test(unbounded));
  check('unbounded is large (full corpus)', unbounded.length > 200000, `len=${unbounded.length}`);
  check(
    'unbounded preserves completion order (Task 0 before Task 21)',
    unbounded.indexOf('Task 0\n') < unbounded.indexOf('Task 21\n')
  );

  // ---- Bounded (worker path) caps count + truncates bodies ----
  const bounded = e._formatPreviousTaskResults(state, { maxResults: 8, maxBodyChars: 2000 });
  check(
    'bounded is dramatically smaller',
    bounded.length < unbounded.length / 10,
    `len=${bounded.length}`
  );
  check('bounded stays under a sane ceiling', bounded.length < 25000, `len=${bounded.length}`);
  check('bounded keeps the MOST RECENT results', bounded.includes('Task 21'));
  check('bounded drops the OLDEST results', !bounded.includes('Task 0\n'));
  check('bounded signals omission', /omitted/i.test(bounded), bounded.slice(0, 120));
  check(
    'bounded truncates long bodies',
    /truncat/i.test(bounded),
    'expected a truncation marker on oversized bodies'
  );

  // ---- Edge cases ----
  check('empty state → empty string', e._formatPreviousTaskResults({ data: {} }) === '');
  const small = makeState(2, 100);
  const smallBounded = e._formatPreviousTaskResults(small, { maxResults: 8, maxBodyChars: 2000 });
  check('few small results → no omission marker', !/omitted/i.test(smallBounded));
  check('few small results → no truncation marker', !/truncat/i.test(smallBounded));

  // ---- Wiring: buildMessages bounds workers but not the synthesizer ----
  const ctx = { language: 'en' };
  const userOf = msgs => (msgs.find(m => m.role === 'user') || {}).content || '';

  const workerMsgs = e.buildMessages({ prompt: '{{previousTaskResults}}' }, state, ctx);
  const synthMsgs = e.buildMessages(
    { prompt: '{{previousTaskResults}}', _isSynthesizer: true },
    state,
    ctx
  );
  const workerUser = userOf(workerMsgs);
  const synthUser = userOf(synthMsgs);

  check(
    'synthesizer user message carries the full corpus',
    synthUser.length > 200000,
    `len=${synthUser.length}`
  );
  check('worker user message is bounded', workerUser.length < 25000, `len=${workerUser.length}`);
  check('worker << synthesizer', workerUser.length < synthUser.length / 10);
  check('worker still includes the most recent task', workerUser.includes('Task 21'));

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
