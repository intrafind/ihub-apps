#!/usr/bin/env node

/**
 * Unit tests for the per-run artifact quota in
 * `server/agents/runtime/artifactStore.js`.
 *
 * Without these caps a buggy or adversarial agent calling `write_artifact`
 * in a loop can fill the disk under contents/data/agent-artifacts/<runId>/.
 * The store tracks running artifacts via `state.data._agent.artifacts`;
 * the quota check rejects the write before it touches the filesystem.
 *
 * Run directly: `node server/tests/agent-artifact-quota.test.js`.
 */

import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import { writeArtifactDirect } from '../agents/runtime/artifactStore.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  // Use a unique run id under the real artifacts root. The store creates
  // the directory itself; we clean it up at the end.
  const runId = `quota-test-${Date.now()}`;
  const root = path.join(getRootDir(), 'contents', 'data', 'agent-artifacts');
  const runDir = path.join(root, runId);

  try {
    console.log('🧪 artifact quota — count cap (50 per run)\n');
    {
      const state = { data: { _agent: { artifacts: [] } } };
      // Write 50 small artifacts — all should succeed.
      for (let i = 0; i < 50; i++) {
        await writeArtifactDirect({
          runId,
          name: `task_${i}.md`,
          content: `tiny`,
          state
        });
      }
      check('50 artifacts accepted', state.data._agent.artifacts.length === 50);

      // The 51st should be rejected with the quota error code.
      let rejected = false;
      let code;
      try {
        await writeArtifactDirect({
          runId,
          name: `task_overflow.md`,
          content: 'oops',
          state
        });
      } catch (err) {
        rejected = true;
        code = err.code;
      }
      check('51st artifact rejected', rejected);
      check(
        'rejection carries ARTIFACT_QUOTA_EXCEEDED code',
        code === 'ARTIFACT_QUOTA_EXCEEDED',
        `got code=${code}`
      );
      check(
        'artifacts list is not mutated by rejected write',
        state.data._agent.artifacts.length === 50
      );
    }

    console.log('\n🧪 artifact quota — byte cap (100MB per run)\n');
    {
      const state = { data: { _agent: { artifacts: [] } } };
      // Push artifacts whose accumulated `bytes` claims to be ~95MB. We
      // simulate the bookkeeping rather than writing real 95MB files —
      // the quota check trusts the `bytes` field already recorded.
      state.data._agent.artifacts.push({ name: 'huge1.md', bytes: 60 * 1024 * 1024 });
      state.data._agent.artifacts.push({ name: 'huge2.md', bytes: 35 * 1024 * 1024 });
      // Now try to add 10MB more — that would push past the 100MB limit.
      const bigContent = 'x'.repeat(10 * 1024 * 1024);
      let rejected = false;
      let code;
      try {
        await writeArtifactDirect({
          runId,
          name: `huge3.md`,
          content: bigContent,
          state
        });
      } catch (err) {
        rejected = true;
        code = err.code;
      }
      check('byte-cap overflow rejected', rejected);
      check('rejection carries ARTIFACT_QUOTA_EXCEEDED code', code === 'ARTIFACT_QUOTA_EXCEEDED');
    }

    console.log('\n🧪 artifact quota — header-injection name still rejected\n');
    {
      const state = { data: { _agent: { artifacts: [] } } };
      let rejected = false;
      let msg;
      try {
        await writeArtifactDirect({
          runId,
          name: 'evil\r\nContent-Type: text/html',
          content: 'pwn',
          state
        });
      } catch (err) {
        rejected = true;
        msg = err.message;
      }
      check('CRLF in name rejected', rejected, `msg=${msg}`);
    }
  } finally {
    // Best-effort cleanup of the run directory + any artifacts left over.
    try {
      await fs.rm(runDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
