#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

/**
 * Boot smoke test: starts the real server entrypoint and asserts it comes up,
 * serves /api/health and shuts down again on SIGTERM.
 *
 * The unit and integration suites import modules directly, so nothing there
 * fails when `server/server.js` itself throws on startup — a broken import, a
 * bad migration or a crash in the boot sequence ships green. This script is the
 * guard for that class of failure.
 *
 * Each scenario boots against a throwaway CONTENTS_DIR, so the fresh-install
 * path (default config copied from server/defaults, every migration applied
 * from scratch) is exercised too. CONTENTS_DIR is resolved against the root
 * dir, so a repo-relative throwaway directory keeps everything under the
 * git-ignored `.smoke-contents/`.
 *
 * Usage: node scripts/smoke-boot.js [--keep-logs]
 */

const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const SCENARIOS = [
  {
    name: 'single-process (WORKERS=1)',
    env: { WORKERS: '1' }
  },
  {
    name: 'cluster round-robin (WORKERS=2)',
    env: { WORKERS: '2' }
  },
  {
    name: 'cluster sticky sessions (WORKERS=2, STICKY_SESSIONS=true)',
    env: { WORKERS: '2', STICKY_SESSIONS: 'true' }
  },
  {
    name: 'upgrade with Agent Factory data (WORKERS=1)',
    env: { WORKERS: '1' },
    seed: seedAgentFactoryData,
    verify: verifyAgentFactoryRemoved,
    verifyStopped: verifyAgentFactoryRunsSettled
  }
];

/**
 * The files the removed Agent Factory left in an installation (#3773). The
 * server must boot on them and leave them where they are.
 */
const AGENT_FACTORY_FILES = {
  'agents/profiles/legacy-agent.json': JSON.stringify({
    id: 'legacy-agent',
    name: { en: 'Legacy agent' },
    description: { en: 'Written before the Agent Factory was removed.' },
    enabled: true,
    workflow: { ref: 'external', workflowId: 'legacy-agent-workflow' }
  }),
  'agents/memory/legacy-agent.md': '## iFinder corpus map\n\nTwo sources.\n',
  'data/agent-inboxes/legacy-inbox.md': '# Inbox\n\n- [ ] open item\n',
  'data/agent-artifacts/wf-exec-legacy/report.md': '# Report\n'
};

const AGENT = { profileId: 'legacy-agent', triggeredBy: { userId: 'alice', kind: 'manual' } };

/**
 * Executions stored before the upgrade, in the run store of the server's
 * filesystem provider (`<contents>/data`). Two unfinished Agent Factory runs
 * must end cancelled with the reason `AGENT_FACTORY_REMOVED`; a plain run of a
 * shipped workflow that carries `_agent.artifacts` (the artifact store writes
 * that into any run that writes an artifact) is no Agent Factory run and is
 * resumed.
 */
const AGENT_FACTORY_RUNS = {
  'wf-exec-smoke-agent-running': {
    workflowId: 'legacy-agent-workflow',
    status: 'running',
    data: { _agent: AGENT }
  },
  'wf-exec-smoke-agent-paused': {
    workflowId: 'legacy-agent-workflow',
    status: 'paused',
    data: { _agent: AGENT }
  }
};
const PLAIN_RUN_ID = 'wf-exec-smoke-plain-artifact';
const PLAIN_RUN = {
  workflowId: 'document-analysis',
  status: 'running',
  data: { _agent: { artifacts: [{ name: 'report.md', bytes: 9 }] } }
};

/** The workflow-state store of the provider a starting server uses on these contents. */
async function openRunStore(contentsPath) {
  const serverUrl = name => pathToFileURL(join(rootDir, 'server', name)).href;
  const { FilesystemStorageProvider } = await import(
    serverUrl('storage/providers/filesystem/index.js')
  );
  const { WorkflowStateRepository } = await import(
    serverUrl('services/workflow/WorkflowStateRepository.js')
  );
  const provider = new FilesystemStorageProvider({ baseDir: join(contentsPath, 'data') });
  await provider.initialize();
  const repository = new WorkflowStateRepository({
    documents: provider.documents,
    locks: provider.locks
  });
  return { provider, repository };
}

async function seedAgentFactoryData(contentsPath) {
  for (const [relative, content] of Object.entries(AGENT_FACTORY_FILES)) {
    const file = join(contentsPath, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  // Every step before the end is done, so a resume has only the end step left.
  const shipped = JSON.parse(
    await readFile(
      join(rootDir, 'server/defaults/workflows', `${PLAIN_RUN.workflowId}.json`),
      'utf8'
    )
  );
  const completedNodes = shipped.nodes.map(node => node.id).filter(id => id !== 'end');
  const { provider, repository } = await openRunStore(contentsPath);
  try {
    const runs = { ...AGENT_FACTORY_RUNS, [PLAIN_RUN_ID]: PLAIN_RUN };
    for (const [executionId, run] of Object.entries(runs)) {
      await repository.write(executionId, {
        executionId,
        ...run,
        currentNodes: ['end'],
        completedNodes,
        failedNodes: [],
        errors: [],
        checkpoints: [],
        history: []
      });
    }
  } finally {
    await provider.shutdown();
  }
}

/** Resolves when the server logged the end of its workflow recovery, or after the timeout. */
async function waitForLogLine(getOutput, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(getOutput())) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** The Agent Factory API is gone, its files are still there. */
async function verifyAgentFactoryRemoved(port, contentsPath, getOutput) {
  const failures = [];
  for (const path of [
    '/api/agents/runs',
    '/api/agents/profiles/legacy-agent/runs',
    '/api/admin/agents'
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5000)
    });
    // 404 problem+json with the code NOT_FOUND, as for any API path no route serves.
    if (response.status !== 404) {
      failures.push(`GET ${path} answered ${response.status}, expected 404`);
    }
    const type = response.headers.get('content-type') || '';
    const body = await response.json().catch(() => null);
    if (!type.startsWith('application/problem+json') || body?.code !== 'NOT_FOUND') {
      failures.push(`GET ${path} answered ${type} ${JSON.stringify(body)}, expected problem+json`);
    }
  }
  if (!(await waitForLogLine(getOutput, /Initialized \d+ workflow triggers/, 60_000))) {
    failures.push('the workflow recovery did not finish within 60s');
  }
  for (const relative of Object.keys(AGENT_FACTORY_FILES)) {
    try {
      await access(join(contentsPath, relative));
    } catch {
      failures.push(`the boot removed ${relative}`);
    }
  }
  return failures;
}

/** After the server stopped: the Agent Factory runs are cancelled, the plain run was not. */
async function verifyAgentFactoryRunsSettled(contentsPath) {
  const failures = [];
  const { provider, repository } = await openRunStore(contentsPath);
  try {
    for (const executionId of Object.keys(AGENT_FACTORY_RUNS)) {
      const state = await repository.read(executionId);
      const reason = state?.history?.find(entry => entry.type === 'workflow_cancelled')?.data
        ?.reason;
      if (state?.status !== 'cancelled' || reason !== 'AGENT_FACTORY_REMOVED') {
        failures.push(
          `${executionId} ended ${state?.status} (reason ${reason}), expected cancelled with AGENT_FACTORY_REMOVED`
        );
      }
    }
    const plain = await repository.read(PLAIN_RUN_ID);
    const cancel = plain?.history?.find(entry => entry.type === 'workflow_cancelled');
    if (!plain || plain.status === 'cancelled' || cancel || !plain.data?._resumedAt) {
      failures.push(
        `${PLAIN_RUN_ID} ended ${plain?.status} (cancel ${JSON.stringify(cancel?.data ?? null)}, resumed at ${plain?.data?._resumedAt}), expected it resumed and not cancelled`
      );
    }
  } finally {
    await provider.shutdown();
  }
  return failures;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Reserve a free TCP port by binding to :0 and releasing it. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Scan captured server output for boot failures. Warnings are expected on a
 * fresh install (missing API keys, config validation notes) and are ignored.
 */
function findFatalLogLines(output) {
  return output
    .split('\n')
    .filter(line => /"level":"error"|Uncaught exception|UnhandledPromiseRejection/.test(line))
    .slice(0, 10);
}

async function waitForHealth(port, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        ok: false,
        reason: `process exited (code=${child.exitCode}, signal=${child.signalCode}) before serving`
      };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.status !== 'OK') {
          return { ok: false, reason: `unexpected health payload: ${JSON.stringify(body)}` };
        }
        // A failed storage bootstrap is non-fatal by design, so `status` stays
        // OK and the server serves — which is exactly why a boot that quietly
        // came up without a provider used to look identical to a good one
        // here. The run ledger would record nothing, configuration would take
        // the filesystem path, and chats would report persistence off.
        if (body?.storage?.ready !== true) {
          return {
            ok: false,
            reason: `booted without storage: ${JSON.stringify(body?.storage ?? null)}`
          };
        }
        return { ok: true, body };
      }
    } catch {
      // not listening yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, reason: `did not serve /api/health within ${READY_TIMEOUT_MS / 1000}s` };
}

/** SIGTERM the server and wait for the process tree to actually exit. */
async function shutdown(child) {
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
  child.kill('SIGTERM');
  const result = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => false)]);
  if (!result) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
    return {
      ok: false,
      reason: `did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s of SIGTERM (needed SIGKILL)`
    };
  }
  return { ok: true };
}

async function runScenario(scenario, keepLogs) {
  const port = await findFreePort();
  // Repo-relative on purpose: the server resolves CONTENTS_DIR against the root dir.
  const contentsDir = join('.smoke-contents', randomUUID());
  const contentsPath = join(rootDir, contentsDir);
  await mkdir(contentsPath, { recursive: true });
  if (scenario.seed) await scenario.seed(contentsPath);

  let output = '';
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CONTENTS_DIR: contentsDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      TELEMETRY_ENABLED: 'false',
      ...scenario.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));

  const failures = [];
  try {
    const ready = await waitForHealth(port, child, Date.now() + READY_TIMEOUT_MS);
    if (!ready.ok) failures.push(ready.reason);

    const fatal = findFatalLogLines(output);
    if (fatal.length)
      failures.push(`error-level log output during boot:\n    ${fatal.join('\n    ')}`);

    if (ready.ok && scenario.verify) {
      failures.push(...(await scenario.verify(port, contentsPath, () => output)));
    }

    if (ready.ok) {
      const stopped = await shutdown(child);
      if (!stopped.ok) failures.push(stopped.reason);
      if (stopped.ok && scenario.verifyStopped) {
        failures.push(...(await scenario.verifyStopped(contentsPath)));
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (keepLogs) {
      console.log(`  log tail (${contentsPath}):`);
      console.log(
        output
          .split('\n')
          .slice(-20)
          .map(l => `    ${l}`)
          .join('\n')
      );
    }
    await rm(contentsPath, { recursive: true, force: true });
  }

  return { failures, output };
}

async function main() {
  const keepLogs = process.argv.includes('--keep-logs');
  let failed = 0;

  console.log('🔥 Boot smoke test: starting the real server entrypoint\n');

  for (const scenario of SCENARIOS) {
    process.stdout.write(`▶ ${scenario.name} ... `);
    const started = Date.now();
    const { failures, output } = await runScenario(scenario, keepLogs);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (failures.length === 0) {
      console.log(`✅ booted, served /api/health and shut down (${seconds}s)`);
      continue;
    }

    failed += 1;
    console.log(`❌ FAILED (${seconds}s)`);
    for (const failure of failures) console.log(`  - ${failure}`);
    if (!keepLogs) {
      console.log('  last 30 log lines:');
      console.log(
        output
          .split('\n')
          .slice(-30)
          .map(l => `    ${l}`)
          .join('\n')
      );
    }
  }

  if (!keepLogs) await rm(join(rootDir, '.smoke-contents'), { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\n❌ Boot smoke test failed: ${failed} of ${SCENARIOS.length} scenarios broken`);
    process.exit(1);
  }
  console.log(`\n✅ All ${SCENARIOS.length} boot scenarios passed`);
}

main().catch(error => {
  console.error('❌ Boot smoke test crashed:', error);
  process.exit(1);
});
