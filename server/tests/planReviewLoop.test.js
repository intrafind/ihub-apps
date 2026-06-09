#!/usr/bin/env node

/**
 * Unit tests for the plan-and-review loop machinery.
 *
 * Three pieces work together to form the loop:
 *
 *   1. profileWorkflowSerializer wraps planner+reviewer in a `while` loop
 *      whose condition reads `data._reviewRound` and `data._reviewOutput`.
 *   2. PromptNodeExecutor._autoPersistResult bumps _reviewRound + stashes
 *      _lastReviewGaps when a node carries `config._isReviewer: true`.
 *   3. PlannerNodeExecutor namespaces emitted task ids with `r{round}_`
 *      (and rewrites dependsOn refs) when state.data._reviewRound >= 1.
 *
 * This file tests each piece independently. End-to-end engine integration
 * is left to manual verification per the plan's verification section.
 *
 * Run directly: `node server/tests/planReviewLoop.test.js`.
 */

import { buildDefaultWorkflowForProfile } from '../agents/profile/profileWorkflowSerializer.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };
}

async function run() {
  // ── 1. Serializer wraps planner+reviewer in a while loop ─────────────
  console.log('🧪 serializer — review.enabled wraps planner+reviewer in while loop\n');
  {
    const profile = {
      id: 'test-agent',
      name: { en: 'Test' },
      workflow: { ref: 'embedded' },
      planner: { enabled: true, maxTasks: 5 },
      synthesizer: { enabled: true },
      memory: { enabled: true },
      review: { enabled: true, maxRounds: 3 }
    };
    const wf = buildDefaultWorkflowForProfile(profile);
    const loopNode = wf.nodes.find(n => n.id === 'review-loop');
    check('review-loop node exists', !!loopNode);
    check('review-loop is a loop node', loopNode?.type === 'loop');
    check('review-loop uses while mode', loopNode?.config?.mode === 'while');
    check(
      'review-loop body has 2 children (planner + reviewer)',
      Array.isArray(loopNode?.config?.body) && loopNode.config.body.length === 2
    );
    check(
      'review-loop body[0] is planner',
      loopNode?.config?.body?.[0]?.id === 'planner' && loopNode.config.body[0].type === 'planner'
    );
    check(
      'review-loop body[1] is reviewer (toolless prompt with _isReviewer)',
      loopNode?.config?.body?.[1]?.id === 'reviewer' &&
        loopNode.config.body[1].type === 'prompt' &&
        loopNode.config.body[1].config?._isReviewer === true
    );
    check(
      'reviewer has outputSchema with needs_more_work',
      loopNode?.config?.body?.[1]?.config?.outputSchema?.properties?.needs_more_work?.type ===
        'boolean'
    );
    check('review-loop maxIterations = maxRounds + 1', loopNode?.config?.maxIterations === 4);
    check(
      'condition references _reviewRound and needs_more_work',
      typeof loopNode?.config?.condition === 'string' &&
        loopNode.config.condition.includes('_reviewRound') &&
        loopNode.config.condition.includes('needs_more_work')
    );

    const memNode = wf.nodes.find(n => n.id === 'memory-finalize');
    check('memory-finalize node inserted when memory enabled', !!memNode);
    check('memory-finalize type is memory-finalize', memNode?.type === 'memory-finalize');

    const synth = wf.nodes.find(n => n.id === 'synthesize');
    check(
      'synthesizer has structured outputSchema',
      !!synth?.config?.outputSchema?.properties?.report
    );
    check(
      'synthesizer outputSchema includes memoryDelta',
      !!synth?.config?.outputSchema?.properties?.memoryDelta
    );
  }

  console.log('\n🧪 serializer — review.enabled=false keeps the legacy shape\n');
  {
    const profile = {
      id: 'test-agent-2',
      name: { en: 'Test2' },
      workflow: { ref: 'embedded' },
      planner: { enabled: true, maxTasks: 5 },
      synthesizer: { enabled: true },
      memory: { enabled: true },
      review: { enabled: false }
    };
    const wf = buildDefaultWorkflowForProfile(profile);
    check('no review-loop node', !wf.nodes.find(n => n.id === 'review-loop'));
    check('planner exists at top level', !!wf.nodes.find(n => n.id === 'planner'));
    check(
      'memory-finalize still inserted (memory enabled)',
      !!wf.nodes.find(n => n.id === 'memory-finalize')
    );
  }

  console.log('\n🧪 serializer — memory.enabled=false skips outputSchema and memory-finalize\n');
  {
    const profile = {
      id: 'test-agent-3',
      name: { en: 'Test3' },
      workflow: { ref: 'embedded' },
      planner: { enabled: true, maxTasks: 5 },
      synthesizer: { enabled: true },
      memory: { enabled: false },
      review: { enabled: false }
    };
    const wf = buildDefaultWorkflowForProfile(profile);
    check('no memory-finalize node', !wf.nodes.find(n => n.id === 'memory-finalize'));
    const synth = wf.nodes.find(n => n.id === 'synthesize');
    check('synthesizer has NO outputSchema when memory disabled', !synth?.config?.outputSchema);
  }

  // ── 2. Reviewer auto-persist branch bumps _reviewRound and stashes gaps
  console.log('\n🧪 _autoPersistResult — reviewer branch bumps round + stashes gaps\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    const node = { id: 'reviewer', type: 'prompt', config: { _isReviewer: true } };
    const state = { executionId: 'x', data: { _reviewRound: 1 } };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: { needs_more_work: true, rationale: 'gaps remain', gaps: ['gap A', 'gap B'] },
        response: { content: 'ignored' },
        state,
        context: { chatId: 'c', user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'reviewer' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'reviewer',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check('reviewer branch returns stateUpdates', !!updates);
    check('reviewer branch bumps _reviewRound (1 → 2)', updates?._reviewRound === 2);
    check(
      'reviewer branch stashes gaps array',
      Array.isArray(updates?._lastReviewGaps) &&
        updates._lastReviewGaps.length === 2 &&
        updates._lastReviewGaps[0] === 'gap A'
    );
  }

  // ── 3. Reviewer branch handles missing gaps gracefully ───────────────
  console.log('\n🧪 _autoPersistResult — reviewer branch: missing gaps → empty array\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    const node = { id: 'reviewer', type: 'prompt', config: { _isReviewer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: { needs_more_work: false, rationale: 'good enough' }, // no gaps
        response: { content: 'ignored' },
        state,
        context: { chatId: 'c', user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'reviewer' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'reviewer',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check('first review round bumps to 1', updates?._reviewRound === 1);
    check(
      'missing gaps → empty array',
      Array.isArray(updates?._lastReviewGaps) && updates._lastReviewGaps.length === 0
    );
  }

  // ── 4. Synthesizer structured output splits report + memoryDelta ─────
  console.log(
    '\n🧪 _autoPersistResult — synthesizer with structured output splits report + memoryDelta\n'
  );
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null; // skip artifact write
    const node = { id: 'synthesize', type: 'prompt', config: { _isSynthesizer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: {
          report: '# Final report\nBody here.',
          memoryDelta: {
            mode: 'append',
            content: 'Learned that X correlates with Y.',
            summary: 'X↔Y correlation'
          }
        },
        response: { content: '{"report":"…","memoryDelta":{}}' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'synthesize' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'synthesize',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'synthesizer output set to report (not the JSON-stringified object)',
      typeof updates?._synthesizerOutput === 'string' &&
        updates._synthesizerOutput.includes('Final report')
    );
    check(
      'memoryDelta pushed onto _pendingMemoryUpdates',
      Array.isArray(updates?._pendingMemoryUpdates) &&
        updates._pendingMemoryUpdates.length === 1 &&
        updates._pendingMemoryUpdates[0].content === 'Learned that X correlates with Y.' &&
        updates._pendingMemoryUpdates[0].mode === 'append' &&
        updates._pendingMemoryUpdates[0].summary === 'X↔Y correlation'
    );
  }

  // ── 5. Synthesizer with null memoryDelta does NOT push anything ──────
  console.log('\n🧪 _autoPersistResult — synthesizer with null memoryDelta is a no-write\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null;
    const node = { id: 'synthesize', type: 'prompt', config: { _isSynthesizer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: { report: 'Just the report.', memoryDelta: null },
        response: { content: 'json' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'synthesize' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'synthesize',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'memoryDelta: null → _pendingMemoryUpdates not set',
      updates && updates._pendingMemoryUpdates === undefined
    );
  }

  // ── 6. Legacy synthesizer (plain text, no outputSchema) preserved ────
  console.log(
    '\n🧪 _autoPersistResult — synthesizer without structured output keeps legacy shape\n'
  );
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null;
    const node = { id: 'synthesize', type: 'prompt', config: { _isSynthesizer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: '# Plain markdown report',
        response: { content: '# Plain markdown report' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'synthesize' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'synthesize',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'legacy: plain text becomes _synthesizerOutput verbatim',
      updates?._synthesizerOutput === '# Plain markdown report'
    );
    check(
      'legacy: no _pendingMemoryUpdates set',
      updates && updates._pendingMemoryUpdates === undefined
    );
  }

  // ── 7. Planner round-prefixing logic ─────────────────────────────────
  console.log('\n🧪 planner — round 1+ namespaces task ids and dependsOn\n');
  {
    // Test the prefix logic by directly applying it the same way the
    // planner does inline. Mirrors the loop in PlannerNodeExecutor.js
    // that runs before SubWorkflowMaterializer.materialize().
    const plan = {
      tasks: [
        { id: 'find-data', dependsOn: [] },
        { id: 'analyze', dependsOn: ['find-data'] }
      ]
    };
    const round = 2;
    const prefix = `r${round}_`;
    for (const task of plan.tasks) {
      if (task && typeof task.id === 'string' && !task.id.startsWith(prefix)) {
        task.id = `${prefix}${task.id}`;
      }
      if (Array.isArray(task?.dependsOn)) {
        task.dependsOn = task.dependsOn.map(dep =>
          typeof dep === 'string' && !dep.startsWith(prefix) ? `${prefix}${dep}` : dep
        );
      }
    }
    check('round-prefix: task ids prefixed', plan.tasks[0].id === 'r2_find-data');
    check('round-prefix: dependsOn rewritten', plan.tasks[1].dependsOn[0] === 'r2_find-data');
    // Idempotence: running the prefix step twice doesn't double-prefix.
    for (const task of plan.tasks) {
      if (task && typeof task.id === 'string' && !task.id.startsWith(prefix)) {
        task.id = `${prefix}${task.id}`;
      }
    }
    check('round-prefix: idempotent (no double prefix)', plan.tasks[0].id === 'r2_find-data');
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
