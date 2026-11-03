// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage of integration actions for the action detail (#2974): calls, errors,
 * approvals, rejections, expired approvals and admin tests per installation
 * and action, over the last days.
 *
 * Nothing else in iHub counts per action: the usage events
 * (`UsageEventLog.js`) count tokens per app and model, the audit log records
 * admin actions without payloads, and the run ledger keeps runs, not totals.
 * So this is a small counter of its own:
 *
 * - one JSONL file per UTC day under `contents/data/integration-action-usage/`
 *   (`2026-11-02.jsonl`), one line per event `{ ts, i, a, k }` (installation
 *   id, action name, kind). No user, no arguments, no result;
 * - appended through the shared JSONL appender (buffered, flushed every 10 s;
 *   several workers append to the same file safely);
 * - files older than {@link RETENTION_DAYS} days are deleted when the usage
 *   is read.
 *
 * Who writes: `integrationTools.runIntegrationTool` (`call`, `error`),
 * {@link startActionUsageTracking} on the interaction service (`approved`,
 * `rejected`, `expired` for approval interactions of integration actions) and
 * the action tester (`test`, never counted as a call).
 *
 * @module services/integrations/actionUsage
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { createJsonlAppender } from '../../utils/jsonlAppender.js';
import { getContentsPath } from '../../utils/contentsPath.js';

const COMPONENT = 'ActionUsage';

/** The event kinds this counter knows. */
export const ACTION_USAGE_KINDS = Object.freeze([
  'call',
  'error',
  'approved',
  'rejected',
  'expired',
  'test'
]);

/** Days of usage the action detail shows. */
export const USAGE_WINDOW_DAYS = 7;

/** Days of files kept; older ones are deleted on read. */
export const RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

let usageDir = getContentsPath('data', 'integration-action-usage');

/** The UTC day of a date as `YYYY-MM-DD`. */
function dayOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

const appender = createJsonlAppender({
  getFilePath: entry => path.join(usageDir, `${dayOf(entry.ts)}.jsonl`),
  component: COMPONENT,
  maxQueueSize: 10_000
});

/**
 * Count one event of an action. Never throws: counting must not fail a call.
 *
 * @param {string} instanceId - the installation id
 * @param {string} action - the action's own name
 * @param {'call'|'error'|'approved'|'rejected'|'expired'|'test'} kind
 * @param {Date|number} [at] - when (tests)
 */
export function recordActionEvent(instanceId, action, kind, at = Date.now()) {
  try {
    if (!instanceId || !action || !ACTION_USAGE_KINDS.includes(kind)) return;
    appender.append({
      ts: new Date(at).toISOString(),
      i: String(instanceId).slice(0, 128),
      a: String(action).slice(0, 128),
      k: kind
    });
  } catch (error) {
    logger.warn('Could not count an integration action event', {
      component: COMPONENT,
      error: error.message
    });
  }
}

/** Delete the day files older than the retention; best effort. */
async function pruneOldFiles(files, now) {
  const oldest = dayOf(now - RETENTION_DAYS * DAY_MS);
  for (const file of files) {
    const day = FILE_PATTERN.exec(file)?.[1];
    if (day && day < oldest) {
      await fs.unlink(path.join(usageDir, file)).catch(() => {});
    }
  }
}

/**
 * The usage of one action over the last `days` days (today included).
 *
 * @param {string} instanceId
 * @param {string} action
 * @param {Object} [options]
 * @param {number} [options.days=7]
 * @param {number} [options.now] - epoch ms (tests)
 * @returns {Promise<{days: number, since: string, calls: number, errors: number,
 *   approved: number, rejected: number, expired: number, tests: number,
 *   lastCallAt: string|null, lastErrorAt: string|null}>}
 */
export async function readActionUsage(instanceId, action, options = {}) {
  const days = Math.min(Math.max(Number(options.days) || USAGE_WINDOW_DAYS, 1), RETENTION_DAYS);
  const now = options.now ?? Date.now();
  const since = new Date(now - days * DAY_MS).toISOString();
  const usage = {
    days,
    since,
    calls: 0,
    errors: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    tests: 0,
    lastCallAt: null,
    lastErrorAt: null
  };
  try {
    await appender.flush();
  } catch {
    // What is on disk is still counted.
  }
  let files = [];
  try {
    files = await fs.readdir(usageDir);
  } catch {
    return usage;
  }
  const firstDay = dayOf(since);
  for (const file of files.sort()) {
    const day = FILE_PATTERN.exec(file)?.[1];
    if (!day || day < firstDay) continue;
    let content = '';
    try {
      content = await fs.readFile(path.join(usageDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.i !== instanceId || event.a !== action || !(event.ts >= since)) continue;
      switch (event.k) {
        case 'call':
          usage.calls += 1;
          if (!usage.lastCallAt || event.ts > usage.lastCallAt) usage.lastCallAt = event.ts;
          break;
        case 'error':
          usage.errors += 1;
          if (!usage.lastErrorAt || event.ts > usage.lastErrorAt) usage.lastErrorAt = event.ts;
          break;
        case 'approved':
          usage.approved += 1;
          break;
        case 'rejected':
          usage.rejected += 1;
          break;
        case 'expired':
          usage.expired += 1;
          break;
        case 'test':
          usage.tests += 1;
          break;
        default:
          break;
      }
    }
  }
  await pruneOldFiles(files, now);
  return usage;
}

/**
 * The installation and action an approval interaction is about, or null.
 * @param {Object} interaction
 * @returns {{instanceId: string, action: string}|null}
 */
export function approvalTargetOf(interaction) {
  if (interaction?.kind !== 'approval') return null;
  const integration = interaction.prompt?.displayData?.integration;
  if (!integration?.id || !integration.action) return null;
  return { instanceId: String(integration.id), action: String(integration.action) };
}

let tracked = null;

/**
 * Count the answers to approval interactions of integration actions:
 * `approved`, `rejected` and `expired`. Listens to the interaction service's
 * events on this worker (each answer is emitted by the worker that took it).
 * Called once at startup; a second call is a no-op.
 *
 * @param {import('node:events').EventEmitter} interactionService
 */
export function startActionUsageTracking(interactionService) {
  if (tracked || !interactionService?.on) return;
  tracked = interactionService;
  interactionService.on('answered', interaction => {
    const target = approvalTargetOf(interaction);
    if (!target) return;
    const decision = interaction.answer?.decision;
    if (decision === 'approve') recordActionEvent(target.instanceId, target.action, 'approved');
    else if (decision === 'reject') recordActionEvent(target.instanceId, target.action, 'rejected');
  });
  interactionService.on('expired', interaction => {
    const target = approvalTargetOf(interaction);
    if (target) recordActionEvent(target.instanceId, target.action, 'expired');
  });
}

/** Test hook: write to another directory and drop what is buffered. */
export async function _setActionUsageDir(dir) {
  await appender.flush().catch(() => {});
  usageDir = dir;
}

/** Test hook: write what is buffered now. */
export async function _flushActionUsage() {
  await appender.flush();
}
