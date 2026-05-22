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
      //
      // Track the LLM-call duration separately from the total node duration
      // (which includes the long sub-workflow wait). The step timeline uses
      // the LLM-only time so "Planning" shows ~8s instead of ~5min.
      const planningStartedAt = new Date();
      const planningStartMs = planningStartedAt.getTime();

      // Step log for the planner LLM call. Filled in by _generatePlan and
      // persisted at the end of execute() so operators can see the model,
      // the resolved goal/system prompt, and the resulting plan reasoning.
      const stepLog = {
        nodeId: node.id,
        kind: 'planner',
        startedAt: planningStartedAt.toISOString(),
        toolCalls: []
      };

      let plan;
      const maxReplans = 1;
      for (let attempt = 0; attempt <= maxReplans; attempt++) {
        plan = await this._generatePlan(goal, config, state, context, stepLog);

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
      try {
        const { getStateManager } = await import('../StateManager.js');
        const stateManager = getStateManager();
        await stateManager.update(state.executionId, {
          data: {
            _stepLogs: {
              ...(state?.data?._stepLogs || {}),
              [node.id]: stepLog
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

      // Emit SSE event so the UI can display the plan. Note: payload fields
      // are FLAT (not nested under `data:`) to match how WorkflowEngine
      // ._emitEvent and agentTools emit do it — the SSE forwarder serializes
      // the whole event object and the client reads top-level fields.
      actionTracker.emit('fire-sse', {
        event: 'workflow.plan.created',
        chatId: context.chatId,
        plan: { tasks: plan.tasks, reasoning: plan.reasoning },
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
          data: { planCreated: { tasks: plan.tasks, reasoning: plan.reasoning } }
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
            language: context.language
          }
        );

        // Wait for child workflow to complete
        const childResult = await this._waitForChildCompletion(childExecutionId, context);

        if (childResult.status === 'failed') {
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
          planCreated: { tasks: plan.tasks, reasoning: plan.reasoning }
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
            planCreated: { tasks: plan.tasks, reasoning: plan.reasoning }
          }
        }
      );
    } catch (error) {
      return this.createErrorResult(`Planner failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
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
  async _generatePlan(goal, config, state, context, stepLog) {
    const { language = 'en' } = context;

    // Resolve which model to use for planning
    const { data: models } = configCache.getModels();
    const model =
      models?.find(m => m.id === config.modelId) || models?.find(m => m.default) || models?.[0];

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

    // Build skills context for the planner so it can decide which (if any)
    // skill knowledge applies to this brief. Two outputs influence runtime:
    //   - skills_used:           pre-activate these before tasks run
    //   - activate_then_replan:  load these now and re-plan once with the
    //                            skill bodies in context
    // The planner sees only metadata here; bodies are loaded by the runtime
    // when the planner returns its JSON (or via the iterative replan flow).
    let skillsBlock = '';
    let activeSkillsBlock = '';
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

    const systemPrompt = `${baseSystem}${skillsBlock}${activeSkillsBlock}`;

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

    const userPrompt = `Goal: ${goal}

${contextData ? `Available context:\n${contextData}\n` : ''}${skillsGuidance}
Create a plan with up to ${config.maxTasks || 10} tasks. Return JSON:
{
${hasSkills ? '  "activate_then_replan": [],\n  "skills_used": [],\n' : ''}  "tasks": [
    {
      "id": "unique-task-id",
      "title": "Task title",
      "description": "Detailed description of what this task should accomplish",
      "tools": [],
      "dependsOn": []
    }
  ],
  "reasoning": "Brief explanation of the plan"
}`;

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

    const response = await this.llmHelper.executeStreamingRequest({
      model,
      messages,
      apiKey: apiKeyResult.apiKey,
      options: { temperature: 0.7 },
      language
    });

    if (stepLog) {
      stepLog.tokens = response.usage || null;
      stepLog.responseLength = typeof response.content === 'string' ? response.content.length : 0;
    }

    // Extract and parse JSON from the LLM response
    const content = response.content || '';
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (stepLog) {
          stepLog.reasoning = parsed.reasoning || null;
        }
        return parsed;
      }
      throw new Error('No JSON found in LLM response');
    } catch (e) {
      throw new Error(`Failed to parse plan: ${e.message}`);
    }
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
