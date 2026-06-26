/**
 * PlannerNodeExecutor
 *
 * Executes 'planner' type nodes in the workflow DAG. A planner node uses an
 * LLM to decompose a high-level goal into a structured plan of tasks, then
 * materializes that plan into a sub-workflow and executes it via the engine.
 *
 * Flow:
 * 1. Resolve the goal string from config (supports variable substitution)
 * 2. Call LLM to generate a structured task plan (JSON)
 * 3. Validate the plan (unique IDs, dependency integrity, cycle detection)
 * 4. Materialize the plan into a workflow definition via SubWorkflowMaterializer
 * 5. Execute the sub-workflow via context.engine.executeSubWorkflow()
 * 6. Poll for child completion and return aggregated results
 *
 * @module services/workflow/executors/PlannerNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { SubWorkflowMaterializer } from '../SubWorkflowMaterializer.js';
import configCache from '../../../configCache.js';
import { actionTracker } from '../../../actionTracker.js';

export class PlannerNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new PlannerNodeExecutor
   * @param {Object} options - Executor options
   * @param {WorkflowLLMHelper} [options.llmHelper] - LLM helper instance for API calls
   */
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  /**
   * Execute the planner node: generate a plan and optionally run it as a sub-workflow.
   *
   * @param {Object} node - The planner node configuration
   * @param {Object} node.config - Node-specific config
   * @param {string} node.config.goal - The high-level goal to decompose (supports variable refs)
   * @param {number} [node.config.maxTasks=10] - Maximum number of tasks in the plan
   * @param {number} [node.config.maxDepth=3] - Maximum sub-workflow nesting depth
   * @param {boolean} [node.config.synthesize] - Whether to add a synthesizer node
   * @param {Object} [node.config.taskTemplate] - Default config applied to each task node
   * @param {string} [node.config.modelId] - Model ID for the planning LLM call
   * @param {string} [node.config.system] - Custom system prompt for the planner
   * @param {string} [node.config.outputVariable] - State key to store the final result
   * @param {Object} state - Current workflow execution state
   * @param {Object} context - Execution context with engine, user, chatId, etc.
   * @returns {Promise<Object>} Execution result with plan and optional sub-workflow results
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const maxDepth = config.maxDepth ?? 3;
    const currentDepth = context.depth || 0;

    // Guard against excessive sub-workflow nesting
    if (currentDepth >= maxDepth) {
      return this.createErrorResult(`Sub-workflow depth limit (${maxDepth}) exceeded`, {
        nodeId: node.id,
        currentDepth,
        maxDepth
      });
    }

    // Hoisted above the try/catch so the failure handler can read them when
    // _generatePlan or validation throws before the success-path step-log
    // write would have fired.
    const planningStartedAt = new Date();
    const planningStartMs = planningStartedAt.getTime();
    const stepLog = {
      nodeId: node.id,
      kind: 'planner',
      startedAt: planningStartedAt.toISOString(),
      toolCalls: []
    };

    try {
      // Resolve goal with template variables from state
      const goal = this.resolveVariables(config.goal, state);
      if (!goal) {
        return this.createErrorResult('Planner goal is required', { nodeId: node.id });
      }

      // Iterative planning: the planner may ask to activate skills first and
      // then re-plan with their bodies in context. We allow ONE replan cycle
      // to prevent infinite loops. After the cycle, any further activations
      // happen via the task workers calling activate_skill themselves.

      let plan;
      const maxReplans = 1;
      for (let attempt = 0; attempt <= maxReplans; attempt++) {
        plan = await this._generatePlan(goal, config, state, context, stepLog, node.id);

        const requested = Array.isArray(plan?.activate_then_replan)
          ? plan.activate_then_replan.filter(s => typeof s === 'string')
          : [];
        if (requested.length === 0 || attempt === maxReplans) break;

        // Load each requested skill body and persist into state. The next
        // _generatePlan iteration will pick them up via _activatedSkills.
        await this._activateSkillsIntoState(requested, state, context);
      }

      // Validate plan structure and dependencies
      const validationError = this._validatePlan(plan, config.maxTasks || 10);
      if (validationError) {
        return this.createErrorResult(`Invalid plan: ${validationError}`, { nodeId: node.id });
      }

      // Global plan-task budget across the whole run. Per-node `maxTasks`
      // bounds one planner call; nested planners (sub-workflow → planner) can
      // multiply unbounded without this check. The budget lives in state.data
      // so child sub-workflow planners share it with the parent.
      const budgetError = this._checkAndUpdatePlanBudget(plan, state, node);
      if (budgetError) {
        return this.createErrorResult(budgetError, { nodeId: node.id });
      }

      // Read the in-flight review round once, so every code path below
      // (step-log key, SSE payload, task-id namespacing) uses a consistent
      // value. Round 0 = first planner pass; the reviewer bumps this at the
      // end of each iteration.
      const activeReviewRound = Number.isFinite(state?.data?._reviewRound)
        ? state.data._reviewRound
        : 0;

      // Planning phase is DONE here — the LLM call returned a valid plan.
      // Capture the LLM-only duration NOW (not after _waitForChildCompletion,
      // which would conflate planning with the entire sub-workflow wait)
      // and emit the step-complete event so the UI's Planning row flips to
      // `done` with its real timing the moment the plan exists.
      const planningCompletedMs = Date.now();
      const planningDurationMs = planningCompletedMs - planningStartMs;
      const planningCompletedAtIso = new Date(planningCompletedMs).toISOString();
      stepLog.completedAt = planningCompletedAtIso;
      stepLog.durationMs = planningDurationMs;
      stepLog.plannedTaskCount = Array.isArray(plan?.tasks) ? plan.tasks.length : 0;
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.step.completed',
          chatId: context.chatId,
          nodeId: node.id,
          kind: 'planner',
          startedAt: planningStartedAt.toISOString(),
          completedAt: planningCompletedAtIso,
          durationMs: planningDurationMs
        });
      } catch {
        // best effort
      }

      // Persist the planner step log right away. We can't wait for the
      // bubble-up at the end of the sub-workflow — if the run times out
      // there, the audit trail for the planner's own LLM call would be
      // lost.
      //
      // Inside a plan-and-review loop the planner runs once per iteration
      // and node.id is constant ('planner'). Suffix the log key by round
      // so iteration N's transcript doesn't overwrite iteration N-1's.
      // Round 0 stays as plain node.id for backward-compat with non-review
      // runs and pre-loop tooling.
      const plannerLogKey = activeReviewRound >= 1 ? `${node.id}_r${activeReviewRound}` : node.id;
      try {
        const { getStateManager } = await import('../StateManager.js');
        const stateManager = getStateManager();
        await stateManager.update(state.executionId, {
          data: {
            _stepLogs: {
              ...(state?.data?._stepLogs || {}),
              [plannerLogKey]: stepLog
            }
          }
        });
      } catch (writeErr) {
        this.logger.warn('Failed to persist planner step log', {
          component: 'PlannerNodeExecutor',
          nodeId: node.id,
          error: writeErr.message
        });
      }

      // Pre-activate `skills_used` from the final plan so each materialized
      // task worker sees the skill body without having to call activate_skill
      // itself. The planner has already decided which skills apply to this
      // brief; making the bodies eagerly available saves a tool-call hop.
      const skillsUsed = Array.isArray(plan?.skills_used)
        ? plan.skills_used.filter(s => typeof s === 'string')
        : [];
      if (skillsUsed.length > 0) {
        await this._activateSkillsIntoState(skillsUsed, state, context);
      }

      // Plan-and-review namespacing: when this planner call runs INSIDE a
      // review loop on round 1+, prefix every emitted task id (and
      // matching dependsOn references) with `r{round}_`. Round 0 (the
      // initial plan) keeps the LLM's ids as-is. The prefix is the
      // safety net for an LLM that re-uses earlier round ids despite the
      // round-extension instructions in the system prompt — without it,
      // _taskResults[task.id] would silently overwrite the prior round's
      // entry for the same id.
      //
      // This MUST run before we emit/persist the plan below so the SSE event,
      // the early persist, and the materialized sub-workflow all use the SAME
      // (namespaced) task ids — otherwise round-1 rows would first appear
      // un-namespaced and then change ids after materialization.
      this._namespaceTaskIds(plan, activeReviewRound);

      // Accumulate the plan across review rounds. A re-plan round emits only
      // the NEW gap-closing tasks, but the UI's Tasks panel renders solely
      // from planCreated.tasks — so without merging, the prior round's tasks
      // disappear from view even though their results/logs persist in
      // _taskResults/_stepLogs. Merge the prior rounds' tasks (from parent
      // state) with this round's namespaced tasks, matching how _taskResults
      // and _stepLogs already accumulate on bubble-up. Namespacing guarantees
      // the ids don't collide across rounds. Computed once and reused for
      // every planCreated write in this execution.
      const mergedPlanTasks = this._mergePlanTasks(state?.data?.planCreated?.tasks, plan.tasks);

      // Emit SSE event so the UI can display the plan. Note: payload fields
      // are FLAT (not nested under `data:`) to match how WorkflowEngine
      // ._emitEvent and agentTools emit do it — the SSE forwarder serializes
      // the whole event object and the client reads top-level fields.
      actionTracker.emit('fire-sse', {
        event: 'workflow.plan.created',
        chatId: context.chatId,
        plan: { tasks: mergedPlanTasks, reasoning: plan.reasoning },
        nodeId: node.id
      });

      // Persist the plan to parent state IMMEDIATELY (before the long-running
      // sub-workflow wait) so the UI's Tasks panel can show what was planned
      // even if the run later times out or fails. Without this the UI only
      // sees `planCreated` after a successful child completion, which means
      // any failed run looks like "no tasks were ever created".
      try {
        const { getStateManager } = await import('../StateManager.js');
        const stateManager = getStateManager();
        await stateManager.update(state.executionId, {
          data: { planCreated: { tasks: mergedPlanTasks, reasoning: plan.reasoning } }
        });
      } catch (writeErr) {
        this.logger.warn('Failed to persist planCreated early; UI may show tasks late', {
          component: 'PlannerNodeExecutor',
          nodeId: node.id,
          error: writeErr.message
        });
      }

      // Materialize the plan into a runnable workflow definition
      const workflowDef = SubWorkflowMaterializer.materialize(plan, config, currentDepth);

      // Propagate the remaining wall-time budget from the parent into the
      // sub-workflow. The engine's default sub-workflow wall budget is 5 min
      // — way too short for a multi-task LLM decomposition. Without this the
      // sub-workflow times out at 300s even when the parent has 600s allowed,
      // and the parent planner node's `_waitForChildCompletion` reports
      // "Sub-workflow failed" with no useful detail.
      const parentDeadline = state?.data?._executionDeadline;
      const remainingMs = Math.max(
        60_000,
        typeof parentDeadline === 'number' ? parentDeadline - Date.now() - 5_000 : 30 * 60 * 1000
      );
      workflowDef.config = {
        ...(workflowDef.config || {}),
        maxExecutionTime: remainingMs
      };

      // Execute sub-workflow if the engine reference is available
      if (context.engine) {
        const parentExecutionId = state.executionId;
        // Pass only application-level data to the sub-workflow. We must NOT
        // share the parent's `nodeResults` / `_workflowDefinition` etc by
        // reference: StateManager.addStep mutates `state.data.nodeResults[id]`,
        // and if the child shares that same object, the mutation creates a
        // self-reference (sub-start → result → stateUpdates → nodeResults →
        // sub-start …) that drives deepMerge into infinite recursion.
        const SHARED_INTERNAL_KEYS = new Set([
          'nodeResults',
          'nodeInvocations',
          'executionMetrics',
          '_workflow',
          '_workflowDefinition',
          '_childExecutionIds',
          '_executionDeadline',
          '_pausedAt',
          '_pausedAtMs',
          '_pauseReason',
          '_resumedAt',
          '_resumeCount',
          '_totalElapsedMs',
          '_humanWaitMs',
          '_nodeIterations',
          '_currentStep',
          // _agent must NOT be shared by reference. The parent pre-initialises
          // `_agent: { artifacts: [] }` in initialData. A shallow copy here
          // would hand the same array to the child, and the child's
          // writeArtifactDirect calls would push into the parent's array
          // directly — bypassing the bubble-up step and double-counting once
          // bubble-up also concatenates the same entries.
          '_agent'
        ]);
        const childInitial = {};
        for (const [k, v] of Object.entries(state.data || {})) {
          if (!SHARED_INTERNAL_KEYS.has(k)) childInitial[k] = v;
        }
        // Give the child a fresh _agent skeleton carrying just the metadata
        // (profileId, triggeredBy) — but a NEW artifacts array so writes
        // don't leak across the boundary.
        if (state?.data?._agent && typeof state.data._agent === 'object') {
          const { artifacts: _ignoredArts, ...agentMeta } = state.data._agent;
          childInitial._agent = { ...agentMeta, artifacts: [] };
        }
        childInitial._planGoal = goal;
        const childExecutionId = await context.engine.executeSubWorkflow(
          parentExecutionId,
          workflowDef,
          childInitial,
          {
            depth: currentDepth + 1,
            maxDepth,
            user: context.user,
            chatId: context.chatId,
            appConfig: context.appConfig,
            language: context.language,
            // Always checkpoint per-node in planner-spawned sub-workflows.
            // Tasks here are multi-minute LLM calls; without disk persistence
            // a server restart during a research run loses all progress
            // (parent's planner is blocked waiting, so the parent's
            // after-node checkpoint doesn't fire until the whole sub-workflow
            // finishes).
            checkpointOnNode: true
          }
        );

        // Wait for child workflow to complete
        const childResult = await this._waitForChildCompletion(childExecutionId, context);

        if (childResult.status === 'failed') {
          // Bubble up whatever the child completed BEFORE it failed, so the UI
          // can still show — and EXPAND (model + transcript) — the sub-tasks
          // that finished. createErrorResult carries no stateUpdates and the
          // engine doesn't apply them on a failed node, so persist directly
          // (same pattern as the early planCreated persist above). Without
          // this, one failed sub-task discards the ENTIRE round's _stepLogs /
          // _taskResults, leaving its siblings unexpandable with no model.
          try {
            const failedChildData = childResult.data || {};
            const partial = {};
            if (failedChildData._taskResults && typeof failedChildData._taskResults === 'object') {
              partial._taskResults = {
                ...(state?.data?._taskResults || {}),
                ...failedChildData._taskResults
              };
            }
            if (failedChildData._stepLogs && typeof failedChildData._stepLogs === 'object') {
              partial._stepLogs = {
                ...(state?.data?._stepLogs || {}),
                ...failedChildData._stepLogs
              };
            }
            if (failedChildData._taskTimings && typeof failedChildData._taskTimings === 'object') {
              partial._taskTimings = {
                ...(state?.data?._taskTimings || {}),
                ...failedChildData._taskTimings
              };
            }
            if (
              Array.isArray(failedChildData._citations) &&
              failedChildData._citations.length > 0
            ) {
              partial._citations = [
                ...(state?.data?._citations || []),
                ...failedChildData._citations
              ];
            }
            if (Object.keys(partial).length > 0) {
              const { getStateManager } = await import('../StateManager.js');
              await getStateManager().update(state.executionId, { data: partial });
            }
          } catch (bubbleErr) {
            this.logger.warn('Failed to bubble up partial sub-workflow state after child failure', {
              component: 'PlannerNodeExecutor',
              nodeId: node.id,
              error: bubbleErr.message
            });
          }
          return this.createErrorResult('Sub-workflow failed', {
            nodeId: node.id,
            childExecutionId,
            errors: childResult.errors
          });
        }

        // Bubble child sub-workflow state up to the parent. The child ran in
        // isolation and accumulated task results, activated skills, artifacts,
        // and citations — all of which the synthesizer needs to see.
        // Without this, the parent's synthesize node reads an empty
        // _taskResults / _citations / _activatedSkills and hallucinates from
        // training data instead of grounding in the actual research.
        const childData = childResult.data || {};
        const bubbledUpdates = {
          planCreated: { tasks: mergedPlanTasks, reasoning: plan.reasoning }
        };

        // Bubble up per-task timings AND persist the planner's own LLM-only
        // time (we emitted the SSE event already up top; this is the
        // post-refresh source of truth via state.data._taskTimings).
        const childTimings =
          childData._taskTimings && typeof childData._taskTimings === 'object'
            ? childData._taskTimings
            : {};
        bubbledUpdates._taskTimings = {
          ...(state?.data?._taskTimings || {}),
          ...childTimings,
          [node.id]: {
            startedAt: planningStartedAt.toISOString(),
            completedAt: planningCompletedAtIso,
            durationMs: planningDurationMs,
            // Flag this as the LLM-only planning slice — separate from the
            // (much longer) total node duration the engine will record.
            kind: 'planner-llm-only'
          }
        };

        // Per-task results map keyed by task id. Each entry has
        // { taskId, nodeId, title, content, model, completedAt }.
        if (childData._taskResults && typeof childData._taskResults === 'object') {
          bubbledUpdates._taskResults = {
            ...(state?.data?._taskResults || {}),
            ...childData._taskResults
          };
        }

        // Skills the task workers activated mid-run via the activate_skill
        // tool. Merge with any skills the planner pre-activated on the
        // parent state.
        if (childData._activatedSkills && typeof childData._activatedSkills === 'object') {
          bubbledUpdates._activatedSkills = {
            ...(state?.data?._activatedSkills || {}),
            ...childData._activatedSkills
          };
        }

        // Bubble up step transcripts so the parent's audit trail covers
        // every step in the run — including the per-task LLM calls that
        // happened inside the child sub-workflow.
        if (childData._stepLogs && typeof childData._stepLogs === 'object') {
          bubbledUpdates._stepLogs = {
            ...(state?.data?._stepLogs || {}),
            ...childData._stepLogs
          };
        }

        // Artifact metadata (file write log). The actual files are written
        // to the root run's artifacts directory (see _resolveRootRunId in
        // PromptNodeExecutor) so the parent's artifact endpoint can list
        // them. We still need to merge the recorded log so the UI shows
        // artifacts written from inside the sub-workflow.
        //
        // Dedupe by name+writtenAt so even if a legacy shared _agent
        // reference is in play we don't end up with double entries — the
        // synthesizer's References list would otherwise inherit doubles.
        const childArtifacts = childData._agent?.artifacts;
        if (Array.isArray(childArtifacts) && childArtifacts.length > 0) {
          const existingArtifacts = state?.data?._agent?.artifacts || [];
          const seen = new Set();
          const merged = [];
          for (const a of [...existingArtifacts, ...childArtifacts]) {
            if (!a || !a.name) continue;
            const key = `${a.name}|${a.writtenAt || ''}|${a.bytes || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(a);
          }
          bubbledUpdates._agent = {
            ...(state?.data?._agent || {}),
            artifacts: merged
          };
        }

        // Citations (URLs + snippets) accumulated by task workers' tool
        // calls — the grounding ledger the synthesizer uses to cite facts.
        // Named `_citations` (NOT `_sources`) so it doesn't shadow
        // `profile.sources` (configured knowledge bases the agent can
        // look up). Citations are the runtime ledger of URLs the agent
        // actually consulted; sources is the configured catalog.
        if (Array.isArray(childData._citations) && childData._citations.length > 0) {
          bubbledUpdates._citations = [...(state?.data?._citations || []), ...childData._citations];
        }

        // Optional output variable points at the synthesized output (if the
        // child had its own synthesizer) or aggregated node results.
        if (config.outputVariable) {
          bubbledUpdates[config.outputVariable] =
            childData.synthesized_result || childData.nodeResults;
        }

        return this.createSuccessResult(
          {
            plan,
            childExecutionId,
            results: childData.nodeResults || {},
            synthesizedResult: childData.synthesized_result,
            taskResultCount: Object.keys(childData._taskResults || {}).length,
            citationCount: (childData._citations || []).length
          },
          { stateUpdates: bubbledUpdates }
        );
      }

      // No engine available - return plan only (useful for dry-run or testing)
      return this.createSuccessResult(
        { plan },
        {
          stateUpdates: {
            planCreated: { tasks: mergedPlanTasks, reasoning: plan.reasoning }
          }
        }
      );
    } catch (error) {
      // Persist a failure step log so operators can see WHAT went wrong
      // without combing the server logs. Without this, planner failures land
      // as `output: null` in the loop's iteration result and the run timeline
      // looks like the planner simply didn't run.
      try {
        const { getStateManager } = await import('../StateManager.js');
        const stateManager = getStateManager();
        const failedAtIso = new Date().toISOString();
        const partialStepLog = {
          nodeId: node.id,
          kind: 'planner',
          startedAt: stepLog?.startedAt || new Date(planningStartMs).toISOString(),
          completedAt: failedAtIso,
          durationMs: Date.now() - planningStartMs,
          messages: stepLog?.messages || [],
          model: stepLog?.model || null,
          responseLength: stepLog?.responseLength || 0,
          tokens: stepLog?.tokens || null,
          failed: true,
          error: error.message,
          ...(error.code ? { errorCode: error.code } : {}),
          ...(error.status ? { errorStatus: error.status } : {})
        };
        // Match the success-path keying: per-round suffix when inside a
        // review loop so the failure of round N doesn't overwrite the
        // success log of round N-1 (and vice versa).
        const failedRound = Number.isFinite(state?.data?._reviewRound)
          ? state.data._reviewRound
          : 0;
        const failureLogKey = failedRound >= 1 ? `${node.id}_r${failedRound}` : node.id;
        await stateManager.update(state.executionId, {
          data: {
            _stepLogs: {
              ...(state?.data?._stepLogs || {}),
              [failureLogKey]: partialStepLog
            }
          }
        });
      } catch (writeErr) {
        this.logger.warn('Failed to persist planner failure step log', {
          component: 'PlannerNodeExecutor',
          nodeId: node.id,
          originalError: error.message,
          writeError: writeErr.message
        });
      }
      return this.createErrorResult(`Planner failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message,
        ...(error.code ? { errorCode: error.code } : {}),
        ...(error.status ? { errorStatus: error.status } : {})
      });
    }
  }

  /**
   * Generate a structured task plan by calling the LLM.
   *
   * @param {string} goal - The resolved goal string
   * @param {Object} config - Planner node config
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Parsed plan with tasks array and reasoning
   * @throws {Error} If no model is available or LLM response cannot be parsed
   * @private
   */
  async _generatePlan(goal, config, state, context, stepLog, nodeId) {
    const { language = 'en' } = context;

    // Resolve which model to use for planning. config.modelId may have been
    // wiped by a config-cache TTL refresh (it's applied at runtime by mutating
    // the shared cached workflow), so fall back to the DURABLE per-run agent
    // model config before the global default — otherwise planning silently
    // drops to local-vllm and overflows its small context on re-plan rounds.
    const { data: models } = configCache.getModels();
    const configuredModelId = config.modelId || this.resolveConfiguredModelId(state, nodeId);
    const model =
      (configuredModelId && models?.find(m => m.id === configuredModelId)) ||
      models?.find(m => m.default) ||
      models?.[0];

    if (!model) {
      throw new Error('No model available for planning');
    }

    // Verify API key before making the request
    const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
    if (!apiKeyResult.success) {
      throw new Error(apiKeyResult.error?.message || 'API key verification failed');
    }

    const baseSystem =
      config.system ||
      `You are a task planner. Given a goal, break it down into concrete, actionable tasks.
Each task should be independently executable by an AI agent.
Return a structured JSON plan.`;

    // Per-task tool selection guidance — important on Gemini, harmless on
    // other providers. On Gemini, the `webSearch` tool (native grounding,
    // swapped to googleSearch at runtime) is mutually exclusive with all
    // function tools (memory writes, app calls, create_task, …). If a task
    // is assigned BOTH on the same step, every function tool is silently
    // dropped. The planner is the only place we can prevent that — once a
    // task is materialized, the executor honors whatever `tools` array the
    // planner chose.
    const TOOL_SELECTION_GUIDANCE = `

## Tool selection per task (CRITICAL on Gemini models)

Each task you emit can carry its own \`tools\` array. The runtime treats
that array as AUTHORITATIVE for the task — it does NOT merge with the
agent's profile-wide default tools. Semantics:

  - OMIT the \`tools\` field entirely → the task inherits the agent's
    default tools (all of them). This is fine for non-Gemini agents but
    on Gemini it triggers the grounding swap and drops every function
    tool the task might have needed.
  - \`"tools": [...]\` with one or more catalog ids → the task uses
    EXACTLY those tools. No defaults are added.
  - \`"tools": []\` → the task runs with NO tools (pure reasoning step).

Because of this, on Gemini the safe pattern is to ALWAYS set \`tools\`
per task. Some tools cannot be combined on the same task — split
work across separate tasks:

  - For research / fact-finding that needs fresh web data, set
    \`"tools": ["webSearch"]\`. Do NOT add memory or app tools to the
    same task on Gemini — they will be silently dropped.
  - For tasks that consult configured apps or write memory, list the
    function tool ids and OMIT \`webSearch\`.
  - If a single goal needs BOTH fresh search and function-tool work,
    split it into two tasks with a \`dependsOn\` link (search task →
    consume-results task that uses the function tools).`;

    // Round-aware extension block — only emitted on round 2+ (i.e. inside a
    // plan-and-review loop, after the reviewer flagged gaps). Surfaces
    // prior results and the reviewer's gaps so the next plan is purely
    // additive.
    const reviewRound = Number.isFinite(state?.data?._reviewRound) ? state.data._reviewRound : 0;
    const lastGaps = Array.isArray(state?.data?._lastReviewGaps) ? state.data._lastReviewGaps : [];
    let roundExtensionBlock = '';
    if (reviewRound >= 1) {
      const completedTaskCount = Object.keys(state?.data?._taskResults || {}).length;
      const gapsRendered =
        lastGaps.length > 0
          ? lastGaps.map((g, i) => `  ${i + 1}. ${g}`).join('\n')
          : '  (none listed — infer gaps from the brief vs. completed work)';
      roundExtensionBlock = `

## You are EXTENDING a previously planned run (review round ${reviewRound})

A reviewer judged the previous round's work insufficient and asked for more.
You have already produced ${completedTaskCount} completed sub-task result(s)
this run — those results are available in state.data._taskResults to the
runtime. Do NOT recreate tasks for work already done.

Reviewer-identified gaps to close on this round:
${gapsRendered}

Hard rules for this extension plan:
  - Emit ONLY new tasks that close the gaps above.
  - Every task id you emit MUST be NEW (do not reuse ids from prior rounds).
    The runtime additionally namespaces them with the prefix \`r${reviewRound}_\`
    for safety.
  - Keep it tight: typically one task per gap, sometimes two when a gap
    needs both search and follow-up consumption.
  - If you genuinely believe nothing more is needed despite the reviewer's
    request, you may emit a single trivial no-op task that summarizes why
    no further work is warranted — the reviewer will see your reasoning.`;
    }

    // Build skills context for the planner so it can decide which (if any)
    // skill knowledge applies to this brief. Two outputs influence runtime:
    //   - skills_used:           pre-activate these before tasks run
    //   - activate_then_replan:  load these now and re-plan once with the
    //                            skill bodies in context
    // The planner sees only metadata here; bodies are loaded by the runtime
    // when the planner returns its JSON (or via the iterative replan flow).
    let skillsBlock = '';
    let activeSkillsBlock = '';
    let availableSkillNames = [];
    try {
      const skillIds =
        Array.isArray(config?.skills) && config.skills.length > 0 ? config.skills : [];
      if (skillIds.length > 0) {
        const platform = configCache.getPlatform()?.data || {};
        const filtered = await configCache.getSkillsForApp(
          { skills: skillIds },
          { id: context?.user?.profileId || 'planner', groups: [] },
          platform
        );
        if (Array.isArray(filtered) && filtered.length > 0) {
          availableSkillNames = filtered.map(s => s.name).filter(n => typeof n === 'string');
          const entries = filtered
            .map(
              s =>
                `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description || ''}</description>\n  </skill>`
            )
            .join('\n');
          skillsBlock = `\n\n<available_skills>\n${entries}\n</available_skills>`;
        }
      }
      // If skills were already activated earlier in the run, fold their
      // bodies in so the planner can use the procedural knowledge to
      // decompose. This is what makes the re-plan iteration valuable.
      const activated = state?.data?._activatedSkills;
      if (activated && typeof activated === 'object') {
        const blocks = Object.entries(activated)
          .map(([name, entry]) => {
            const body = typeof entry === 'string' ? entry : entry?.body || '';
            return body ? `<active_skill name="${name}">\n${body}\n</active_skill>` : '';
          })
          .filter(Boolean);
        if (blocks.length > 0) {
          activeSkillsBlock = `\n\n${blocks.join('\n\n')}`;
        }
      }
    } catch (skillErr) {
      this.logger.warn('Failed to render planner skills context', {
        component: 'PlannerNodeExecutor',
        error: skillErr.message
      });
    }

    const systemPrompt = `${baseSystem}${TOOL_SELECTION_GUIDANCE}${roundExtensionBlock}${skillsBlock}${activeSkillsBlock}`;

    // Build context summary from state data (exclude internal keys)
    const contextData = Object.entries(state.data || {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');

    const hasSkills = skillsBlock.length > 0;
    const skillsGuidance = hasSkills
      ? `

You may optionally activate skills BEFORE planning the tasks.

  - If a skill in <available_skills> matches this brief and you want its full
    instructions to inform your plan, set "activate_then_replan": ["skill-name"].
    The runtime will load those skills and call you again to produce a final plan.
  - If you already know which skill the task workers should use while
    executing, set "skills_used": ["skill-name"]. The runtime will activate
    them before the tasks run so each task worker sees the skill body.
  - Task descriptions can also mention a skill by name ("Use the X skill to …")
    and the task worker will activate it on demand.

If you set "activate_then_replan", you can omit "tasks" — the runtime ignores
them and re-invokes you with the activated skill bodies in context.`
      : '';

    // Catalogs of what the agent has configured. The planner can ONLY pick
    // from these lists per task — the schema below enum-constrains each
    // field, and the user prompt shows the catalog so the model has explicit
    // guidance. A field with an empty catalog is omitted from BOTH the prompt
    // template and the schema so the model isn't tempted to fabricate values.
    const tt = config?.taskTemplate || {};
    const uniqStrings = arr =>
      Array.isArray(arr) ? Array.from(new Set(arr.filter(v => typeof v === 'string'))) : [];
    const toolCatalog = uniqStrings(tt.tools);
    const appCatalog = uniqStrings(tt.apps);
    const sourceCatalog = uniqStrings(tt.sources);
    const skillCatalog = uniqStrings(availableSkillNames);

    // Skeleton lines for the JSON example. We deliberately DO NOT add empty
    // `"tools": []` / `"apps": []` / `"sources": []` placeholders here —
    // see TOOL_SELECTION_GUIDANCE above: an empty array means "no tools",
    // and an empty literal in the skeleton would nudge the LLM toward
    // emitting `[]` (defeating the per-task split that prevents Gemini's
    // grounding-swap collision). The schema below still ENUM-CONSTRAINS
    // these fields to their respective catalogs, so the LLM knows they
    // exist and what values are allowed; it just isn't shown an "empty"
    // default in the user-prompt template.
    const taskFieldLines = ['      "id": "unique-task-id"', '      "title": "Task title"'];
    taskFieldLines.push(
      '      "description": "Detailed description of what this task should accomplish"'
    );
    if (toolCatalog.length > 0) {
      // Show a populated example so the LLM knows the shape and is nudged to
      // pick from the catalog rather than emit `[]`.
      taskFieldLines.push(`      "tools": ["${toolCatalog[0]}"]`);
    }
    if (appCatalog.length > 0) {
      taskFieldLines.push(`      "apps": ["${appCatalog[0]}"]`);
    }
    if (sourceCatalog.length > 0) {
      taskFieldLines.push(`      "sources": ["${sourceCatalog[0]}"]`);
    }
    taskFieldLines.push('      "dependsOn": []');

    const catalogsBlock = [];
    if (toolCatalog.length > 0) {
      catalogsBlock.push(`tools: ${toolCatalog.map(s => `"${s}"`).join(', ')}`);
    }
    if (appCatalog.length > 0) {
      catalogsBlock.push(`apps: ${appCatalog.map(s => `"${s}"`).join(', ')}`);
    }
    if (sourceCatalog.length > 0) {
      catalogsBlock.push(`sources: ${sourceCatalog.map(s => `"${s}"`).join(', ')}`);
    }
    const catalogsGuidance =
      catalogsBlock.length > 0
        ? `\n\nAvailable resources you may reference per task (use ONLY these exact ids — do not invent):\n  - ${catalogsBlock.join('\n  - ')}`
        : '';

    const userPrompt = `Goal: ${goal}

${contextData ? `Available context:\n${contextData}\n` : ''}${skillsGuidance}${catalogsGuidance}
Create a plan with up to ${config.maxTasks || 10} tasks. Return JSON:
{
${hasSkills ? '  "activate_then_replan": [],\n  "skills_used": [],\n' : ''}  "tasks": [
    {
${taskFieldLines.join(',\n')}
    }
  ],
  "reasoning": "Brief explanation of the plan"
}

Dependency rules:
- If a task uses the output of another task (mapping, synthesizing, comparing, or pitching based on facts the other task gathered, or drafting a final summary/report that should reflect another task's findings), list the upstream task FIRST in the array AND set the dependent task's dependsOn to the upstream task's id.
- Use the exact id string you assigned to the upstream task. Do not use the title. Do not use unquoted identifiers — every dependsOn entry must be a JSON string in double quotes.
- Empty dependsOn means no upstream task is needed. Tasks with empty dependsOn run in array order, so order independent tasks meaningfully too.

Output rules:
- Return ONLY the JSON object. No markdown fences, no prose before or after, no comments.
- Every string value must be in double quotes. Arrays must contain valid JSON values only.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Record what the planner sees on this iteration so operators can
    // audit the resolved goal, the skills folded in, the model picked.
    if (stepLog) {
      stepLog.model = model.id;
      // Truncate per-message body to keep state size manageable.
      const cap = 6000;
      stepLog.messages = messages.map(m => ({
        role: m.role,
        content:
          typeof m.content === 'string' && m.content.length > cap
            ? `${m.content.slice(0, cap)}…[truncated ${m.content.length - cap} chars]`
            : m.content
      }));
      stepLog.tools = []; // planner has no tools by design
    }

    // Constrain the model with an explicit `responseSchema` (not just
    // `responseFormat: json`). Gemini-flash-latest under plain `json` mode
    // has been observed appending stray characters after the outer `}` —
    // a valid object followed by a trailing `}` makes the response unparseable
    // and the planner silently fails. With a schema, Gemini enforces the
    // exact shape and the trailing-junk class of failures goes away.
    //
    // Schema is intentionally flat (no union types, no nested anyOf) so
    // Gemini's proto-derived schema validator accepts it. The Google adapter
    // strips `additionalProperties` automatically.
    //
    // Explicit maxTokens: the Google adapter defaults to 2048, which is enough
    // for typical plans but we'd rather not depend on adapter defaults — and
    // for richer plans (10 tasks × ~200-token descriptions) we need more
    // headroom anyway. 8192 is well within Gemini Flash's output budget.
    // Schema fields mirror the user-prompt template exactly. Any field the
    // prompt doesn't show as part of the JSON example is omitted — otherwise
    // the model tries to fill it and (observed with gemini-flash-latest)
    // degenerates into hallucinating dozens of look-alike string values
    // until it hits maxTokens. Per-task `apps`/`sources`/`skills` aren't
    // consumed downstream anyway — the profile's taskTemplate supplies those.
    // `tools` is REPLACE-when-provided in SubWorkflowMaterializer (the
    // planner's array becomes the task's tool list, the template is
    // dropped). This is what makes the per-task tool-selection guidance
    // actually take effect on Gemini, where webSearch + function tools
    // can't coexist. Cap length to prevent hallucination loops where the
    // model fills the array with dozens of look-alike ids.
    // Enum-constrain every reference field to the configured catalog so the
    // model can't invent ids (observed failure: gemini-flash-latest filled an
    // unconstrained `tools` array with dozens of look-alike hallucinated tool
    // names until it hit maxTokens). A field is included in the schema only
    // when its catalog is non-empty — the prompt template above mirrors the
    // same condition.
    const taskItemProperties = {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 8 }
    };
    if (toolCatalog.length > 0) {
      taskItemProperties.tools = {
        type: 'array',
        items: { type: 'string', enum: toolCatalog },
        maxItems: Math.max(1, toolCatalog.length)
      };
    }
    if (appCatalog.length > 0) {
      taskItemProperties.apps = {
        type: 'array',
        items: { type: 'string', enum: appCatalog },
        maxItems: Math.max(1, appCatalog.length)
      };
    }
    if (sourceCatalog.length > 0) {
      taskItemProperties.sources = {
        type: 'array',
        items: { type: 'string', enum: sourceCatalog },
        maxItems: Math.max(1, sourceCatalog.length)
      };
    }

    const plannerSchemaProperties = {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: taskItemProperties,
          required: ['id', 'title', 'description']
        }
      },
      reasoning: { type: 'string' }
    };
    if (skillCatalog.length > 0) {
      const skillItem = { type: 'string', enum: skillCatalog };
      plannerSchemaProperties.activate_then_replan = {
        type: 'array',
        items: skillItem,
        maxItems: Math.max(1, skillCatalog.length)
      };
      plannerSchemaProperties.skills_used = {
        type: 'array',
        items: skillItem,
        maxItems: Math.max(1, skillCatalog.length)
      };
    }
    const plannerResponseSchema = {
      type: 'object',
      properties: plannerSchemaProperties,
      required: ['tasks']
    };
    // Output-token budget: NEVER hardcode this. A thinking model
    // (gemini-3-flash, gemini-flash-latest) counts its reasoning tokens
    // against the output budget, so a small fixed cap (the old 8192) gets
    // entirely consumed by 30s+ of thinking and the answer JSON is truncated
    // mid-stream → "Failed to parse plan". Derive from the explicit node
    // config, then the resolved model's own maxOutputTokens (32k on
    // gemini-flash-latest), with 8192 only as a last-resort floor. Mirrors
    // PromptNodeExecutor's `config.maxTokens || model.maxOutputTokens || …`.
    const maxTokens = config.maxTokens || model.maxOutputTokens || 8192;
    const response = await this.llmHelper.executeStreamingRequest({
      model,
      messages,
      apiKey: apiKeyResult.apiKey,
      options: {
        temperature: 0.7,
        responseFormat: 'json',
        responseSchema: plannerResponseSchema,
        maxTokens
      },
      language
    });

    if (stepLog) {
      stepLog.tokens = response.usage || null;
      stepLog.responseLength = typeof response.content === 'string' ? response.content.length : 0;
    }

    // Extract and parse JSON from the LLM response. Strategy: try the whole
    // trimmed content first (works when responseFormat=json was honored),
    // then strip a markdown code fence, then fall back to the first-`{` /
    // last-`}` slice. On every failure path we log the raw tail so future
    // parse errors are diagnosable from the server log without needing the
    // step log persisted (which doesn't happen if the planner throws).
    const content = response.content || '';
    const tryParse = candidate => {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    };
    const trimmed = content.trim();
    let parsed = tryParse(trimmed);
    if (!parsed) {
      const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
      if (fenceMatch) parsed = tryParse(fenceMatch[1].trim());
    }
    if (!parsed) {
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
      }
    }
    if (!parsed) {
      const tail = trimmed.length > 600 ? `…${trimmed.slice(-600)}` : trimmed;
      const truncatedByLength = response.finishReason === 'length';
      const truncatedByShape =
        /^(Unterminated|Unexpected end of)/i.test(trimmed) ||
        // The content ends inside an open string / array / object.
        /[":,]\s*$/.test(trimmed) ||
        !/[}\]]\s*$/.test(trimmed);
      const probablyTruncated = truncatedByLength || truncatedByShape;
      this.logger.error('Planner LLM emitted unparseable JSON', {
        component: 'PlannerNodeExecutor',
        modelId: model.id,
        finishReason: response.finishReason,
        usage: response.usage,
        contentLength: content.length,
        probablyTruncated,
        truncationSignal: truncatedByLength
          ? 'finish_reason=length'
          : truncatedByShape
            ? 'content-does-not-end-with-close-bracket'
            : null,
        contentTail: tail
      });
      const remedy = probablyTruncated
        ? ' The response was likely truncated — raise the planner model output cap or use a model with a larger output budget.'
        : ' The response looks complete but is malformed — review the prompt or model.';
      throw new Error(
        `Failed to parse plan: LLM did not return valid JSON (contentLength=${content.length}, finishReason=${response.finishReason || 'unknown'}).${remedy}`
      );
    }
    if (stepLog) {
      stepLog.reasoning = parsed.reasoning || null;
    }
    return parsed;
  }

  /**
   * Validate a plan for structural correctness.
   *
   * Checks:
   * - tasks array exists and is non-empty
   * - task count does not exceed maxTasks
   * - all task IDs are unique
   * - all dependency references point to existing tasks
   * - no circular dependencies exist
   *
   * @param {Object} plan - The plan to validate
   * @param {number} maxTasks - Maximum allowed number of tasks
   * @returns {string|null} Error message if invalid, null if valid
   * @private
   */
  _validatePlan(plan, maxTasks) {
    if (!plan || !Array.isArray(plan.tasks)) {
      return 'Plan must contain a tasks array';
    }
    if (plan.tasks.length === 0) {
      return 'Plan must contain at least one task';
    }
    if (plan.tasks.length > maxTasks) {
      return `Plan exceeds max tasks limit (${plan.tasks.length} > ${maxTasks})`;
    }

    // Check unique task IDs
    const ids = new Set();
    for (const task of plan.tasks) {
      if (!task.id) return 'All tasks must have an id';
      if (ids.has(task.id)) return `Duplicate task ID: ${task.id}`;
      ids.add(task.id);
    }

    // Check that all dependency references point to existing tasks
    for (const task of plan.tasks) {
      if (task.dependsOn) {
        for (const dep of task.dependsOn) {
          if (!ids.has(dep)) return `Task ${task.id} depends on non-existent task: ${dep}`;
        }
      }
    }

    // DFS cycle detection on task dependencies
    const visited = new Set();
    const recursionStack = new Set();

    const hasCycle = taskId => {
      visited.add(taskId);
      recursionStack.add(taskId);

      const task = plan.tasks.find(t => t.id === taskId);
      for (const dep of task?.dependsOn || []) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) return true;
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }

      recursionStack.delete(taskId);
      return false;
    };

    for (const task of plan.tasks) {
      if (!visited.has(task.id)) {
        if (hasCycle(task.id)) return 'Circular dependency detected in task plan';
      }
    }

    return null; // valid
  }

  /**
   * Enforce a per-run total-tasks budget across all planner nodes.
   *
   * Per-node `maxTasks` caps one planner call; without this check, nested
   * planners (e.g. planner → task → planner) can multiply task emission
   * unbounded across the sub-workflow tree. The budget lives in
   * `state.data._planBudget` (a `{ used, max }` record) and is shared by
   * descendant planners through the workflow state.
   *
   * @param {Object} plan - The validated plan about to be materialized
   * @param {Object} state - Current workflow execution state
   * @param {Object} node - The planner node (used in the error message)
   * @returns {string|null} Error message if budget exceeded, null otherwise
   * @private
   */
  _checkAndUpdatePlanBudget(plan, state, _node) {
    const data = (state.data ||= {});
    const budget = (data._planBudget ||= { used: 0, max: 100 });
    const incoming = Array.isArray(plan?.tasks) ? plan.tasks.length : 0;
    if (budget.used + incoming > budget.max) {
      return `Plan budget exceeded: this run has already emitted ${budget.used} task(s) and the planner is trying to add ${incoming} more (limit ${budget.max}).`;
    }
    budget.used += incoming;
    return null;
  }

  /**
   * Namespace every task id (and matching dependsOn references) in `plan` for
   * the given review round.
   *
   * - Round 0 (the initial plan): ids are left unchanged for backward-compat.
   * - Round N≥1: every task id that is not already prefixed `r{N}_` gets the
   *   prefix `r{N}_`. Within-round dependsOn references are re-prefixed to
   *   match; cross-round references (ids not emitted by THIS round) are left
   *   as-is so they can still resolve against prior-round results.
   *
   * This is the safety net that ensures _taskResults / _stepLogs from one
   * review round never overwrite entries from a different round.
   *
   * @param {Object} plan - The plan object (mutated in place)
   * @param {number} reviewRound - The current review round (0-based)
   * @returns {void}
   * @private
   */
  _namespaceTaskIds(plan, reviewRound) {
    if (reviewRound < 1 || !Array.isArray(plan?.tasks)) return;
    const prefix = `r${reviewRound}_`;
    // First pass: collect every task id the LLM emitted on THIS round, so
    // we know which dependsOn references point at same-round tasks
    // (eligible for prefixing) vs. anything else (cross-round, left
    // alone — _validatePlan already rejected unresolvable deps).
    const sameRoundIds = new Set();
    for (const task of plan.tasks) {
      if (task && typeof task.id === 'string') sameRoundIds.add(task.id);
    }
    // Second pass: re-id tasks; rewrite deps ONLY when they reference
    // a same-round task id (or were already prefixed by the LLM).
    for (const task of plan.tasks) {
      if (task && typeof task.id === 'string' && !task.id.startsWith(prefix)) {
        task.id = `${prefix}${task.id}`;
      }
      if (Array.isArray(task?.dependsOn)) {
        task.dependsOn = task.dependsOn.map(dep => {
          if (typeof dep !== 'string') return dep;
          if (dep.startsWith(prefix)) return dep; // already prefixed
          if (sameRoundIds.has(dep)) return `${prefix}${dep}`; // same-round
          return dep; // cross-round ref — preserve as-is
        });
      }
    }
  }

  /**
   * Merge a re-plan round's tasks into the accumulated plan so the run-detail
   * Tasks panel keeps every round's tasks visible. A review-loop round emits
   * only the NEW gap-closing tasks; without this the prior round's tasks (whose
   * results/logs still live in _taskResults/_stepLogs) would vanish from the
   * UI, which renders solely from planCreated.tasks.
   *
   * De-dupes by task id, preserving first-seen order (prior rounds first, this
   * round's new tasks appended). When the same id appears in both, the incoming
   * entry wins (refreshed metadata) but keeps its original position. Cross-round
   * id collisions don't happen in practice because _namespaceTaskIds prefixes
   * round N≥1 ids with `r{N}_`. Tasks without an id are dropped — they can't be
   * keyed or rendered as a stable row.
   *
   * @param {Array<Object>} priorTasks - Accumulated tasks from earlier rounds
   * @param {Array<Object>} incomingTasks - This round's (namespaced) tasks
   * @returns {Array<Object>} Merged, de-duped task list
   * @private
   */
  _mergePlanTasks(priorTasks, incomingTasks) {
    const byId = new Map();
    for (const t of Array.isArray(priorTasks) ? priorTasks : []) {
      if (t && t.id != null) byId.set(t.id, t);
    }
    for (const t of Array.isArray(incomingTasks) ? incomingTasks : []) {
      if (t && t.id != null) byId.set(t.id, t);
    }
    return Array.from(byId.values());
  }

  /**
   * Poll the StateManager until the child sub-workflow reaches a terminal state.
   *
   * @param {string} childExecutionId - The execution ID of the child workflow
   * @param {Object} context - Execution context (for abort signal and deadline checks)
   * @returns {Promise<Object>} The final child execution state
   * @throws {Error} If aborted, deadline exceeded, or timeout reached
   * @private
   */
  async _waitForChildCompletion(childExecutionId, context) {
    const { getStateManager } = await import('../StateManager.js');
    const stateManager = getStateManager();

    const pollInterval = 1000; // 1 second
    const maxWait = 30 * 60 * 1000; // 30 minutes
    const startTime = Date.now();

    while (true) {
      // Check abort signal
      if (context.abortSignal?.aborted) {
        throw new Error('Planner aborted');
      }

      // Check parent execution deadline
      if (
        context.initialData?._executionDeadline &&
        Date.now() > context.initialData._executionDeadline
      ) {
        throw new Error('Parent execution deadline exceeded');
      }

      const childState = await stateManager.get(childExecutionId);
      if (childState) {
        if (
          childState.status === 'completed' ||
          childState.status === 'failed' ||
          childState.status === 'cancelled'
        ) {
          return childState;
        }
      }

      if (Date.now() - startTime > maxWait) {
        throw new Error('Sub-workflow timed out');
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Load each named skill via skillLoader.getSkillContent and persist its
   * body to `state.data._activatedSkills` so subsequent planner iterations,
   * task workers, and the synthesizer see the procedural knowledge through
   * the `<active_skill>` block in their system prompt.
   *
   * Mutates `state.data` in place and also calls stateManager.update so the
   * persisted state on disk reflects the activation — handy for the run
   * detail UI (which renders `_activatedSkills` live) and for resume.
   *
   * Failures per skill are logged and skipped; one bad skill name does not
   * abort the planner.
   *
   * @private
   */
  async _activateSkillsIntoState(skillNames, state, context) {
    if (!Array.isArray(skillNames) || skillNames.length === 0) return;
    const activated = { ...(state?.data?._activatedSkills || {}) };
    const { getSkillContent } = await import('../../skillLoader.js');
    const profileId = context?.user?.profileId;
    const chatId = context?.chatId || state?.executionId;

    for (const name of skillNames) {
      if (typeof name !== 'string' || !name) continue;
      if (activated[name]) continue; // already activated this run
      try {
        const content = await getSkillContent(name);
        if (!content || !content.body) {
          this.logger.warn('Planner requested unknown skill', {
            component: 'PlannerNodeExecutor',
            skillName: name
          });
          continue;
        }
        activated[name] = {
          body: content.body,
          description: content.description || '',
          activatedAt: new Date().toISOString(),
          activatedBy: 'planner'
        };
        try {
          actionTracker.emit('fire-sse', {
            event: 'agent.skill.activated',
            chatId,
            profileId,
            skillName: name,
            description: content.description || '',
            activatedBy: 'planner'
          });
        } catch {
          // Best effort.
        }
      } catch (err) {
        this.logger.warn('Failed to activate skill from planner', {
          component: 'PlannerNodeExecutor',
          skillName: name,
          error: err.message
        });
      }
    }

    // Update in-memory state so the next _generatePlan call sees the new
    // active skills, and persist via stateManager so the UI + resume flow
    // pick them up.
    if (state && state.data) {
      state.data._activatedSkills = activated;
    }
    try {
      const { getStateManager } = await import('../StateManager.js');
      const stateManager = getStateManager();
      if (state?.executionId) {
        await stateManager.update(state.executionId, {
          data: { _activatedSkills: activated }
        });
      }
    } catch (err) {
      this.logger.warn('Failed to persist activated skills', {
        component: 'PlannerNodeExecutor',
        error: err.message
      });
    }
  }
}

export default PlannerNodeExecutor;
