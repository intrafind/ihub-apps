#!/usr/bin/env node

/**
 * Unit tests for the cross-process scheduler lock that prevents multiple iHub
 * instances from double-firing the same scheduled workflow triggers.
 *
 * Run directly: `node server/tests/scheduler-lock.test.js`.
 */

import os from 'os';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import {
  tryAcquireSchedulerLock,
  isSchedulerOwner,
  releaseSchedulerLock,
  _identity
} from '../services/workflow/triggers/schedulerLock.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const lockPath = path.join(os.tmpdir(), `ihub-sched-lock-test-${process.pid}.lock`);

function writeForeignLock(overrides = {}) {
  writeFileSync(
    lockPath,
    JSON.stringify({
      identity: 'someone-else',
      pid: overrides.pid ?? 999999, // unlikely-alive pid
      hostname: overrides.hostname ?? os.hostname(),
      lockTime: overrides.lockTime ?? Date.now()
    }),
    'utf8'
  );
}

async function run() {
  rmSync(lockPath, { force: true });

  console.log('🧪 acquires when no lock exists\n');
  {
    const got = tryAcquireSchedulerLock({ lockPath });
    check('acquired the lock', got === true && isSchedulerOwner() === true);
    check(
      'lock file written with our identity',
      existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf8')).identity === _identity()
    );
  }

  console.log('\n🧪 re-acquire refreshes our own lock\n');
  {
    const t0 = 1_000_000;
    tryAcquireSchedulerLock({ lockPath, now: t0 });
    const again = tryAcquireSchedulerLock({ lockPath, now: t0 + 5000 });
    check('still owner after refresh', again === true);
    check('lockTime advanced', JSON.parse(readFileSync(lockPath, 'utf8')).lockTime === t0 + 5000);
  }

  console.log('\n🧪 does NOT take a fresh foreign lock (live owner)\n');
  {
    // Use our own (alive) pid so the dead-pid takeover path does NOT apply,
    // and a fresh lockTime so it is not stale — a genuinely held foreign lock.
    writeForeignLock({ pid: process.pid, lockTime: Date.now() });
    const got = tryAcquireSchedulerLock({ lockPath });
    check('did not acquire', got === false && isSchedulerOwner() === false);
    check(
      'foreign lock untouched',
      JSON.parse(readFileSync(lockPath, 'utf8')).identity === 'someone-else'
    );
  }

  console.log('\n🧪 takes over a STALE foreign lock (past TTL)\n');
  {
    writeForeignLock({ lockTime: 1000 }); // ancient
    const got = tryAcquireSchedulerLock({ lockPath, now: 1000 + 60_000 });
    check('took over stale lock', got === true && isSchedulerOwner() === true);
    check('now owned by us', JSON.parse(readFileSync(lockPath, 'utf8')).identity === _identity());
  }

  console.log('\n🧪 takes over a same-host lock whose PID is dead\n');
  {
    // Fresh lockTime but a dead PID on this host → eligible for takeover.
    writeForeignLock({ pid: 999999, hostname: os.hostname(), lockTime: Date.now() });
    const got = tryAcquireSchedulerLock({ lockPath });
    check('took over dead-pid lock', got === true && isSchedulerOwner() === true);
  }

  console.log('\n🧪 release removes only our own lock\n');
  {
    tryAcquireSchedulerLock({ lockPath });
    releaseSchedulerLock({ lockPath });
    check('lock file removed', !existsSync(lockPath));
    check('no longer owner', isSchedulerOwner() === false);

    // A foreign lock should NOT be removed by release.
    writeForeignLock();
    releaseSchedulerLock({ lockPath });
    check('foreign lock left in place', existsSync(lockPath));
  }

  rmSync(lockPath, { force: true });
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
