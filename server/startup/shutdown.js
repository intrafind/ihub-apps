// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../utils/logger.js';
import { getShutdownExitCode } from '../utils/processRestart.js';
import { stopChatRetentionSweep } from '../services/chat/chatRetention.js';
import { stopProjectRetentionSweep } from '../services/projects/projectRetention.js';
import { stopWorkflowStateRetention } from '../services/workflow/workflowRetention.js';
import conversationStateManager from '../services/integrations/ConversationStateManager.js';
import { shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { shutdownTelemetry } from '../telemetry.js';

/**
 * Flush and stop everything a worker owns, then exit. Registered for SIGTERM and
 * SIGINT by {@link startWorker}.
 */
export async function shutdown() {
  // Stop the scheduler first, so no new run starts while the rest shuts down.
  try {
    const { stopScheduler } = await import('../services/scheduler/index.js');
    stopScheduler();
  } catch {
    // The scheduler may not have started
  }
  // Stop all workflow triggers before shutdown
  try {
    const { resetTriggerManager } = await import('../services/workflow/triggers/TriggerManager.js');
    resetTriggerManager();
  } catch {
    // Triggers may not have been initialized
  }
  // Flush any buffered audit entries so we don't lose them on shutdown.
  try {
    const { flushAuditLog } = await import('../services/AuditLogService.js');
    await flushAuditLog();
  } catch {
    // Audit flush failures are logged within the service
  }
  // Stop the retention sweeps before storage goes away, so a tick cannot
  // start against a provider that is being torn down.
  stopChatRetentionSweep();
  stopProjectRetentionSweep();
  import('../services/projects/bootstrap.js')
    .then(({ shutdownProjects }) => shutdownProjects())
    .catch(() => {});
  stopWorkflowStateRetention();
  // The extraction threads: a file read in flight is dropped with the process.
  try {
    const { shutdownExtractionPool } = await import('../services/projects/extractionPool.js');
    await shutdownExtractionPool();
  } catch {
    // The pool may never have been loaded
  }
  // Conversation state coalesces its writes on a timer to keep document I/O
  // off the streaming path; drain what is still buffered, or a chat resumes
  // after the restart threaded onto a stale parent message.
  await conversationStateManager.flush();
  // Usage records and quota counts wait in memory for their next flush;
  // write them now rather than losing up to one flush interval.
  // Each flush on its own, so a failed usage write cannot cost quota counts.
  try {
    const { flushQueue } = await import('../services/UsageEventLog.js');
    await flushQueue();
  } catch (error) {
    logger.error('Could not flush usage records on shutdown', {
      component: 'Server',
      error: error?.message
    });
  }
  try {
    const { getQuotaLedger } = await import('../services/quota/QuotaLedger.js');
    await getQuotaLedger().flush();
  } catch (error) {
    logger.error('Could not flush usage-limit counters on shutdown', {
      component: 'Server',
      error: error?.message
    });
  }
  // Flush buffered storage writes (chat documents, append-log entries) and
  // release the provider's handles before the process goes away.
  await shutdownStorageBootstrap();
  await shutdownTelemetry();
  process.exit(getShutdownExitCode());
}
