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
      'review-loop carries execution.timeout (so the engine default 5min does not cancel long planner runs)',
      typeof loopNode?.execution?.timeout === 'number' && loopNode.execution.timeout >= 60_000
    );
    check(
      'condition references _reviewRound and needs_more_work',
      typeof loopNode?.config?.condition === 'string' &&
        loopNode.config.condition.includes('_reviewRound') &&
        loopNode.config.condition.includes('needs_more_work')
    );

    const memComposeNode = wf.nodes.find(n => n.id === 'memory-compose');
    const memFinalizeNode = wf.nodes.find(n => n.id === 'memory-finalize');
    check('memory-compose node inserted when memory enabled', !!memComposeNode);
    check(
      'memory-compose is a toolless prompt with _isMemoryComposer marker',
      memComposeNode?.type === 'prompt' &&
        memComposeNode?.config?._isMemoryComposer === true &&
        Array.isArray(memComposeNode?.config?.tools) &&
        memComposeNode.config.tools.length === 0
    );
    check(
      'memory-compose outputSchema has flat tripartite fields (Gemini-compatible)',
      memComposeNode?.config?.outputSchema?.type === 'object' &&
        memComposeNode.config.outputSchema.properties?.skip?.type === 'boolean' &&
        memComposeNode.config.outputSchema.properties?.mode?.type === 'string' &&
        memComposeNode.config.outputSchema.properties?.semantic?.type === 'string' &&
        memComposeNode.config.outputSchema.properties?.episodic?.type === 'string' &&
        memComposeNode.config.outputSchema.properties?.procedural?.type === 'string'
    );
    check('memory-finalize node inserted when memory enabled', !!memFinalizeNode);
    check('memory-finalize type is memory-finalize', memFinalizeNode?.type === 'memory-finalize');

    const synth = wf.nodes.find(n => n.id === 'synthesize');
    check(
      'synthesizer is plain text (NO outputSchema — memory split into its own step)',
      !synth?.config?.outputSchema
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
      'memory-compose still inserted (memory enabled)',
      !!wf.nodes.find(n => n.id === 'memory-compose')
    );
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
    check('no memory-compose node', !wf.nodes.find(n => n.id === 'memory-compose'));
    check('no memory-finalize node', !wf.nodes.find(n => n.id === 'memory-finalize'));
    const synth = wf.nodes.find(n => n.id === 'synthesize');
    check('synthesizer has NO outputSchema (plain text)', !synth?.config?.outputSchema);
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

  // ── 3b. Reviewer parse-failure: exits cleanly with sentinel verdict ──
  console.log('\n🧪 _autoPersistResult — reviewer parse failure exits cleanly\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    const node = { id: 'reviewer', type: 'prompt', config: { _isReviewer: true } };
    const state = { executionId: 'x', data: { _reviewRound: 0 } };

    // Reviewer output is a string (parse failure / Gemini schema mismatch).
    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: 'oops not json',
        response: { content: 'oops not json' },
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

    check('parse failure: round still bumped (so loop can exit)', updates?._reviewRound === 1);
    check(
      'parse failure: gaps cleared to empty',
      Array.isArray(updates?._lastReviewGaps) && updates._lastReviewGaps.length === 0
    );
    check(
      'parse failure: synthetic _reviewOutput with needs_more_work=false',
      updates?._reviewOutput &&
        updates._reviewOutput.needs_more_work === false &&
        updates._reviewOutput._parseError === true &&
        typeof updates._reviewOutput.rationale === 'string'
    );
  }

  // ── 4. Memory composer branch pushes delta onto _pendingMemoryUpdates ─
  console.log('\n🧪 _autoPersistResult — memory-composer pushes delta\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null;
    const node = { id: 'memory-compose', type: 'prompt', config: { _isMemoryComposer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: {
          skip: false,
          mode: 'append',
          content: 'Found via app__support-bot: X is the lead on Y.',
          summary: 'X→Y lead'
        },
        response: { content: 'json' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'memory-compose' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'memory-compose',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'composer delta pushed onto _pendingMemoryUpdates',
      Array.isArray(updates?._pendingMemoryUpdates) &&
        updates._pendingMemoryUpdates.length === 1 &&
        updates._pendingMemoryUpdates[0].content.startsWith('Found via app__support-bot') &&
        updates._pendingMemoryUpdates[0].mode === 'append' &&
        updates._pendingMemoryUpdates[0].summary === 'X→Y lead'
    );
  }

  // ── 5. Memory composer with skip=true → no-op ────────────────────────
  console.log('\n🧪 _autoPersistResult — memory-composer skip=true is a no-write\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null;
    const node = { id: 'memory-compose', type: 'prompt', config: { _isMemoryComposer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: { skip: true, mode: 'append', content: 'ignored', summary: 'ignored' },
        response: { content: 'json' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'memory-compose' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'memory-compose',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'skip=true → _pendingMemoryUpdates not set',
      updates && updates._pendingMemoryUpdates === undefined
    );
  }

  // ── 6. Memory composer with empty content → no-op ────────────────────
  console.log('\n🧪 _autoPersistResult — memory-composer empty content is a no-write\n');
  {
    const executor = new PromptNodeExecutor({ logger: silentLogger() });
    executor._resolveRootRunId = async () => null;
    const node = { id: 'memory-compose', type: 'prompt', config: { _isMemoryComposer: true } };
    const state = { executionId: 'x', data: {} };

    const updates = (
      await executor._autoPersistResult({
        node,
        config: node.config,
        output: { skip: false, mode: 'append', content: '   ' }, // whitespace only
        response: { content: 'json' },
        state,
        context: { chatId: null, user: { profileId: 'p' } },
        agentProfile: { id: 'p' },
        executeStartedAt: new Date(),
        executeStartMs: Date.now() - 100,
        stepLog: { nodeId: 'memory-compose' },
        effectiveTaskId: null,
        effectiveTaskTitle: null,
        effectiveLogKey: 'memory-compose',
        isDynamicTaskIteration: false
      })
    )?.stateUpdates;

    check(
      'empty/whitespace content → _pendingMemoryUpdates not set',
      updates && updates._pendingMemoryUpdates === undefined
    );
  }

  // ── 7. Synthesizer plain-text path (post-split, no schema) ────────────
  console.log('\n🧪 _autoPersistResult — synthesizer is plain text (memory split out)\n');
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
      'synthesizer: plain text becomes _synthesizerOutput verbatim',
      updates?._synthesizerOutput === '# Plain markdown report'
    );
    check(
      'synthesizer: NO _pendingMemoryUpdates set (memory composer is a separate step)',
      updates && updates._pendingMemoryUpdates === undefined
    );
  }

  // ── 7. Planner round-prefixing logic ─────────────────────────────────
  console.log('\n🧪 planner — round 1+ namespaces task ids and dependsOn\n');
  {
    // Apply the SAME prefix logic the planner uses inline (see
    // PlannerNodeExecutor.js — the same-round-only rewrite that protects
    // cross-round refs from being corrupted). Inlined here so the test
    // doesn't drag in the full planner module's transitive deps.
    function applyRoundPrefix(plan, round) {
      const prefix = `r${round}_`;
      const sameRoundIds = new Set();
      for (const task of plan.tasks) {
        if (task && typeof task.id === 'string') sameRoundIds.add(task.id);
      }
      for (const task of plan.tasks) {
        if (task && typeof task.id === 'string' && !task.id.startsWith(prefix)) {
          task.id = `${prefix}${task.id}`;
        }
        if (Array.isArray(task?.dependsOn)) {
          task.dependsOn = task.dependsOn.map(dep => {
            if (typeof dep !== 'string') return dep;
            if (dep.startsWith(prefix)) return dep;
            if (sameRoundIds.has(dep)) return `${prefix}${dep}`;
            return dep; // cross-round ref preserved
          });
        }
      }
      return plan;
    }

    const plan = {
      tasks: [
        { id: 'find-data', dependsOn: [] },
        { id: 'analyze', dependsOn: ['find-data'] }
      ]
    };
    applyRoundPrefix(plan, 2);
    check('round-prefix: task ids prefixed', plan.tasks[0].id === 'r2_find-data');
    check('round-prefix: dependsOn rewritten', plan.tasks[1].dependsOn[0] === 'r2_find-data');

    // Cross-round protection: a dep referencing a PRIOR round's task id
    // (already-prefixed `r1_*`) must survive intact — not get double-prefixed.
    const planXRound = {
      tasks: [
        // Two new tasks plus an existing-round reference.
        { id: 'followup', dependsOn: ['r1_prior-task'] },
        { id: 'compose', dependsOn: ['followup'] }
      ]
    };
    applyRoundPrefix(planXRound, 2);
    check(
      'cross-round dep: prior-round prefix preserved as-is',
      planXRound.tasks[0].dependsOn[0] === 'r1_prior-task'
    );
    check(
      'cross-round dep: same-round ref still prefixed',
      planXRound.tasks[1].dependsOn[0] === 'r2_followup'
    );

    // Idempotence: running the prefix step twice doesn't double-prefix.
    applyRoundPrefix(plan, 2);
    check('round-prefix: idempotent (no double prefix)', plan.tasks[0].id === 'r2_find-data');
    check('round-prefix: idempotent dependsOn', plan.tasks[1].dependsOn[0] === 'r2_find-data');
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
