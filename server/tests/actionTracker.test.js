#!/usr/bin/env node
/**
 * actionTracker is the internal event bus for workflow/agent runtime events.
 * It must fan events out to every registered listener without tripping Node's
 * MaxListenersExceededWarning, because every SSE connection and every chat
 * bridge registers its own request-scoped listener.
 *
 * Run directly: `node server/tests/actionTracker.test.js`.
 */
import assert from 'node:assert/strict';
import { actionTracker, ActionTracker } from '../actionTracker.js';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`✅ ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`❌ ${label}\n   ${err.message}`);
  }
}

check('fire-sse events reach every listener with the payload intact', () => {
  const bus = new ActionTracker();
  const seen = [];
  const a = e => seen.push(['a', e]);
  const b = e => seen.push(['b', e]);
  bus.on('fire-sse', a);
  bus.on('fire-sse', b);
  bus.emit('fire-sse', { event: 'workflow.node.start', chatId: 'exec-1', nodeId: 'n1' });
  bus.off('fire-sse', a);
  bus.off('fire-sse', b);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0][1], { event: 'workflow.node.start', chatId: 'exec-1', nodeId: 'n1' });
  assert.equal(seen[1][0], 'b');
});

check('no MaxListenersExceededWarning with many concurrent listeners', () => {
  const warnings = [];
  const onWarning = w => warnings.push(w);
  process.on('warning', onWarning);
  const handlers = Array.from({ length: 25 }, () => () => {});
  handlers.forEach(h => actionTracker.on('fire-sse', h));
  actionTracker.emit('fire-sse', { event: 'agent.task.created', chatId: 'exec-2' });
  handlers.forEach(h => actionTracker.off('fire-sse', h));
  process.off('warning', onWarning);
  assert.equal(actionTracker.getMaxListeners(), 0);
  assert.equal(
    warnings.filter(w => w.name === 'MaxListenersExceededWarning').length,
    0,
    'unexpected MaxListenersExceededWarning'
  );
});

check('the shared instance exposes only the bus (no wire-dialect helpers)', () => {
  const helpers = Object.getOwnPropertyNames(ActionTracker.prototype).filter(n =>
    n.startsWith('track')
  );
  assert.deepEqual(helpers, []);
});

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
