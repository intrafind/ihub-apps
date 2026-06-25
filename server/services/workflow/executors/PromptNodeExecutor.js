/**
 * Executor for workflow agent nodes.
 *
 * Agent nodes invoke an LLM with optional tool access. They are the primary
 * way to incorporate AI reasoning into a workflow. Agents can:
 * - Generate text responses
 * - Use tools to gather information or perform actions
 * - Parse structured output according to a schema
 * - Maintain conversation context within the workflow
 *
 * This executor integrates with the existing ChatService and ToolExecutor
 * to provide full LLM capabilities within a workflow context.
 *
 * @module services/workflow/executors/PromptNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import ChatService from '../../chat/ChatService.js';
import { normalizeToolName } from '../../../adapters/toolCalling/index.js';
import { actionTracker } from '../../../actionTracker.js';
import { getToolsForApp, runTool } from '../../../toolLoader.js';
import configCache from '../../../configCache.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { ContextSummarizer } from '../ContextSummarizer.js';
import { estimateTokens } from '../../../usageTracker.js';
import SourceResolutionService from '../../SourceResolutionService.js';
import { createSourceManager } from '../../../sources/index.js';
import config from '../../../config.js';
import { getRootDir } from '../../../pathUtils.js';
import path from 'path';
import logger from '../../../utils/logger.js';
import { getAgentToolIds } from '../../../agents/runtime/agentToolRegistrar.js';
import { readMemoryBodyForPrompt } from '../../../agents/memory/memoryFile.js';
import { getAppAsTools, stripAppToolsForAgent } from '../../../agents/runtime/appAsToolGateway.js';
import { writeArtifactDirect } from '../../../agents/runtime/artifactStore.js';
import { isFeatureEnabled } from '../../../featureRegistry.js';

/**
 * Agent node configuration
 * @typedef {Object} PromptNodeConfig
 * @property {string} [system] - System prompt for the agent
 * @property {string} [prompt] - User prompt template (can contain variable references)
 * @property {Array<string>} [tools] - Tool IDs available to this agent
 * @property {string} [modelId] - Specific model to use (overrides workflow default)
 * @property {number} [temperature] - Temperature for LLM responses
 * @property {number} [maxTokens] - Maximum tokens for response
 * @property {number} [maxIterations] - Maximum tool calling iterations (default: 10)
 * @property {Object} [outputSchema] - JSON schema for structured output
 * @property {string} [outputVariable] - State variable to store the result
 * @property {boolean} [includeHistory] - Include previous messages in context
 */

/**
 * Executor for agent nodes.
 *
 * Agent nodes are responsible for:
 * - Building LLM request messages from state and config
 * - Executing LLM calls with tool support
 * - Processing tool call loops until completion
 * - Parsing structured output according to schema
 * - Storing results in workflow state
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // Prompt node configuration
 * {
 *   id: 'research-step',
 *   type: 'prompt',
 *   name: 'Research Agent',
 *   config: {
 *     system: 'You are a research assistant. Search for relevant information.',
 *     prompt: 'Research the following topic: ${$.data.topic}',
 *     tools: ['source_search', 'web_search'],
 *     modelId: 'gpt-4',
 *     maxIterations: 5,
 *     outputVariable: 'researchResults'
 *   }
 * }
 */
export class PromptNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new PromptNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
    this.chatService = options.chatService || new ChatService();
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
    this.maxIterations = options.maxIterations || 10;
    this.contextSummarizer = new ContextSummarizer();
  }

  /**
   * Execute the agent node.
   *
   * Builds messages, calls the LLM (with tool loop if needed),
   * and returns the agent's response.
   *
   * @param {Object} node - The agent node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Execution result with agent output
   */
  async execute(node, state, context) {
    const { config = {} } = node;
    const { language = 'en' } = context;
    // Capture local start time for accurate per-task timing in _taskResults.
    // The engine wraps the executor in _executeWithTimeout and adds its own
    // metrics, but those land on the result AFTER execute() returns —
    // so the auto-persist (which fires INSIDE execute) can't see them.
    // Recording here lets us put startedAt + durationMs directly into
    // state.data._taskResults so the UI step-timeline doesn't need to
    // cross-reference nodeResults.
    const executeStartedAt = new Date();
    const executeStartMs = executeStartedAt.getTime();

    // Drain-mode body nodes keep the same node.id ("task_runner") across
    // every iteration of the loop. If we keyed transcripts / artifacts /
    // task results by node.id alone, each iteration would overwrite the
    // previous one's records and operators would only ever see the LAST
    // task. Detect the currently-running task from `state.data._currentTask`
    // (set by LoopNodeExecutor before each drain iteration) and treat its
    // id as the effective task id. SubWorkflowMaterializer-emitted planner
    // tasks still set config._taskId directly, so those win.
    const currentTaskFromState = state?.data?._currentTask;
    const effectiveTaskId =
      config?._taskId ||
      (currentTaskFromState && typeof currentTaskFromState.id === 'string'
        ? currentTaskFromState.id
        : null);
    const effectiveTaskTitle =
      config?._taskTitle ||
      (currentTaskFromState && typeof currentTaskFromState.title === 'string'
        ? currentTaskFromState.title
        : null);
    // If we're driving a dequeued dynamic task, treat this node as a
    // planner-task for auto-persist (per-task artifact + _taskResults +
    // _taskQueue markDone) even though config._isPlannerTask wasn't set
    // statically. Use a unique key per task for _stepLogs / _taskTimings
    // so iterations don't clobber each other.
    const isDynamicTaskIteration =
      !config?._taskId && currentTaskFromState && typeof currentTaskFromState.id === 'string';
    const effectiveLogKey = effectiveTaskId || node.id;

    this.logger.info('Executing agent node', {
      component: 'PromptNodeExecutor',
      nodeId: node.id,
      hasTools: (config.tools || []).length > 0,
      ...(effectiveTaskId && effectiveTaskId !== node.id ? { taskId: effectiveTaskId } : {})
    });

    try {
      // Resolve and load sources (node-level overrides workflow-level)
      const {
        content: sourceContent,
        cacheUpdates,
        sourcesMetadata
      } = await this.loadSourceContent(config, state, context);
      if (sourceContent) {
        context = { ...context, sourceContent };
      }
      // Hold onto the resolved sources metadata so we can put it on the
      // step log after model/tools are sorted out. Even when no content
      // came back (errors, all unresolved), still recording the IDs the
      // node WAS configured with makes it visible in the audit.
      const stepSourceMetadata = Array.isArray(sourcesMetadata) ? sourcesMetadata : [];

      // Auto-summarize accumulated cross-node context (Claude Code autocompact
      // analog). Opt-in via `config.autoSummarize: true` for plain workflows;
      // on by default for agent runs (which can accumulate many task results)
      // unless explicitly disabled with `config.autoSummarize: false`. The
      // `needsSummarization` threshold means small runs are untouched.
      const wantSummarize =
        config.autoSummarize === true ||
        (!!context._agentProfile && config.autoSummarize !== false);
      if (wantSummarize && this.contextSummarizer.needsSummarization(state)) {
        state = await this.contextSummarizer.summarizeContext(state, context);
      }

      // Auto-include long-term memory for agent runs (before buildMessages).
      // Synthesizer nodes (`_isSynthesizer: true`) deliberately SKIP memory:
      // their job is composing from the current run's sub-task results and
      // citations only. Pulling in memory drags in stale content from
      // earlier runs (e.g. a memory file that says "Daniel & Rowan" because
      // an earlier hallucinated run wrote that), and the synthesizer drifts
      // off-topic. Task workers still see memory — they're the ones who
      // need recall.
      const earlyAgentProfile = this._resolveAgentProfile(context);
      const skipMemory = config?._isSynthesizer === true;
      if (
        earlyAgentProfile &&
        !skipMemory &&
        earlyAgentProfile.memory?.enabled !== false &&
        earlyAgentProfile.memory?.autoInclude !== false
      ) {
        try {
          const mem = await readMemoryBodyForPrompt(
            earlyAgentProfile.id,
            earlyAgentProfile.memory?.maxBytes || 8192
          );
          if (mem) {
            const header = `# Long-term memory (last updated ${mem.updatedAt || 'unknown'}, version ${mem.version})`;
            context = { ...context, _agentMemoryBlock: `${header}\n\n${mem.body}` };
          }
        } catch (memErr) {
          this.logger.warn('Failed to load agent memory for prompt', {
            component: 'PromptNodeExecutor',
            profileId: earlyAgentProfile.id,
            error: memErr.message
          });
        }
      }

      // Build skill context blocks for agent runs. `<available_skills>` lists
      // skill metadata (name + description) so the LLM knows what knowledge
      // it can activate via the `activate_skill` tool. `<active_skill>`
      // blocks contain the full SKILL.md body for any skills that have been
      // activated earlier in the run (persisted to state.data._activatedSkills
      // by the activate_skill tool or pre-activated by the planner).
      //
      // Synthesizer nodes get the active bodies (so the final composition
      // can follow skill output formats) but not the `<available_skills>`
      // metadata or the activate_skill tool — they don't decide WHAT to do.
      if (earlyAgentProfile) {
        try {
          const skillsBlock = await this._buildSkillsBlock(earlyAgentProfile, config, state);
          if (skillsBlock) {
            context = { ...context, _agentSkillsBlock: skillsBlock };
          }
        } catch (skillErr) {
          this.logger.warn('Failed to load skills for prompt', {
            component: 'PromptNodeExecutor',
            profileId: earlyAgentProfile.id,
            error: skillErr.message
          });
        }
      }

      // Get model configuration first — buildMessages uses it to decide
      // whether image attachments are appropriate for this model.
      // config.modelId may have been wiped by a config-cache TTL refresh (it's
      // applied at runtime by mutating the shared cached workflow). Fall back to
      // the durable per-run agent model config so we don't drop to local-vllm.
      const resolvedModelId = config.modelId || this.resolveConfiguredModelId(state, node.id);
      const model = await this.getModel(resolvedModelId, context, state);
      if (!model) {
        return this.createErrorResult(`Model not found: ${resolvedModelId || 'default'}`, {
          nodeId: node.id
        });
      }

      // Build messages from config and state
      const messages = this.buildMessages(config, state, context, model);

      // Resolve the agent profile if this is an agent run (used by tool registrar,
      // memory auto-include, and App-as-tool gateway).
      const agentProfile = this._resolveAgentProfile(context);

      // Get tools if configured. Agent runs get auto-registered tools
      // (memory/inbox/dynamic-tasks/artifacts) merged on top.
      let configuredToolIds = Array.isArray(config.tools) ? [...config.tools] : [];
      if (agentProfile) {
        const agentToolIds = getAgentToolIds(agentProfile, config);
        for (const id of agentToolIds) {
          if (!configuredToolIds.includes(id)) configuredToolIds.push(id);
        }
      }

      // Auto-attach `activate_skill` / `read_skill_resource` whenever the
      // node has skills available (either on the profile or override on the
      // node config). Synthesizer nodes skip this — they're text-out only.
      const nodeSkillIds =
        Array.isArray(config.skills) && config.skills.length > 0
          ? config.skills
          : Array.isArray(agentProfile?.skills) && agentProfile.skills.length > 0
            ? agentProfile.skills
            : [];
      if (nodeSkillIds.length > 0 && config._isSynthesizer !== true) {
        if (!configuredToolIds.includes('activate_skill')) {
          configuredToolIds.push('activate_skill');
        }
        if (!configuredToolIds.includes('read_skill_resource')) {
          configuredToolIds.push('read_skill_resource');
        }
      }

      // Provider-native search resolution. `webSearch` is configured as an
      // openai-responses-only tool; for Google models the GoogleConverter
      // strips it (then results are pure hallucination because the model
      // has no real search). Swap to `googleSearch` (native grounding).
      //
      // Gemini API limitation: google_search CANNOT be combined with
      // function calling. If we register both, the converter silently
      // drops all function tools and the node loses memory/inbox/task
      // capabilities. So the swap is node-scoped:
      //
      //   - Materialized planner tasks (`_isPlannerTask: true`) become
      //     search-only when grounding is needed. They return text/JSON;
      //     the finalize orchestrator persists the work via
      //     write_artifact / write_inbox afterwards.
      //   - Orchestrator nodes (load-inbox, finalize) don't list webSearch
      //     in their tools so the swap never triggers there; they keep
      //     their function tools.
      //   - Other (non-agent) nodes that explicitly list webSearch on
      //     Google get the same search-only swap. Authors who want both
      //     should split into separate nodes.
      // Track the swap so we can record it on the step log (and tell
      // operators why function tools + apps didn't run on this step).
      let groundingSwapDropped = null;
      if (model?.provider === 'google' && configuredToolIds.includes('webSearch')) {
        const droppedFunctionTools = configuredToolIds.filter(
          id => id !== 'webSearch' && id !== 'googleSearch'
        );
        configuredToolIds = ['googleSearch'];
        groundingSwapDropped = droppedFunctionTools;
        this.logger.info('Swapped webSearch → googleSearch (Google native grounding)', {
          component: 'PromptNodeExecutor',
          modelId: model.id,
          droppedFunctionTools,
          nodeId: node.id
        });
      }
      let tools = [];
      if (configuredToolIds.length > 0) {
        tools = await this.getAgentTools(configuredToolIds, language, context);
      }

      // Append App-as-tool synthetic tools when enabled — BUT NOT after the
      // googleSearch swap fired. Gemini cannot combine native grounding
      // with function calling; if we re-add the app__* tools here, the
      // Google adapter silently drops them anyway, the model never sees
      // them, and operators are left wondering why their apps were never
      // invoked. Skip the append, record the dropped apps on the step
      // log, and surface a clear warning in the UI.
      const droppedApps = [];
      // Per-app status for the step log: every app the profile/node
      // configured gets a row, even when it never got registered. Without
      // this the UI shows "no apps used" and the operator has no idea
      // whether (a) apps weren't configured, (b) the feature flag is off,
      // (c) the grounding swap stripped them, or (d) the model just chose
      // not to call them. Each row tells them exactly which case applies.
      const appsMetadata = [];
      if (agentProfile) {
        const appsForNode = Array.isArray(config.apps) ? config.apps : [];
        if (appsForNode.length > 0) {
          // Feature flag lives in features.json (configCache.getFeatures),
          // NOT in platform.json — the stale `platform.features.appAsTool`
          // entry was a leftover that never tracked the canonical state.
          const appAsToolEnabled = isFeatureEnabled('appAsTool', configCache.getFeatures());
          if (!appAsToolEnabled) {
            this.logger.warn(
              'App-as-tool feature flag is OFF — configured apps will NOT be registered as tools',
              {
                component: 'PromptNodeExecutor',
                nodeId: node.id,
                requestedApps: appsForNode
              }
            );
            for (const id of appsForNode) {
              appsMetadata.push({ id, registered: false, reason: 'feature-flag-off' });
            }
          } else if (groundingSwapDropped) {
            // Apps configured but the grounding swap means they can't
            // co-exist with native search on this model. Don't register
            // them — they would be silently dropped downstream anyway.
            droppedApps.push(...appsForNode.map(a => `app__${a}`));
            this.logger.warn(
              'Apps not registered: Google native grounding is mutually exclusive with function tools',
              {
                component: 'PromptNodeExecutor',
                modelId: model.id,
                nodeId: node.id,
                requestedApps: appsForNode
              }
            );
            for (const id of appsForNode) {
              appsMetadata.push({ id, registered: false, reason: 'grounding-swap' });
            }
          } else {
            const appTools = await getAppAsTools(appsForNode, language);
            const registeredAppToolIds = new Set(
              appTools.map(t => t?.id || t?.function?.name).filter(Boolean)
            );
            tools = tools.concat(appTools);
            for (const id of appsForNode) {
              const registered = registeredAppToolIds.has(`app__${id}`);
              appsMetadata.push(
                registered
                  ? { id, registered: true }
                  : { id, registered: false, reason: 'resolve-failed' }
              );
            }
          }
        }
        // App→App nesting guard: when an agent calls an app internally, strip
        // any synthetic `app__*` tools that would otherwise be forwarded. If
        // the guard dropped any apps we already registered, downgrade their
        // status to reflect that.
        const toolsBeforeNestingStrip = tools;
        tools = stripAppToolsForAgent(tools, context?.user);
        if (tools !== toolsBeforeNestingStrip && tools.length < toolsBeforeNestingStrip.length) {
          const survivingAppToolIds = new Set(
            tools.map(t => t?.id || t?.function?.name).filter(Boolean)
          );
          for (const row of appsMetadata) {
            if (row.registered && !survivingAppToolIds.has(`app__${row.id}`)) {
              row.registered = false;
              row.reason = 'app-in-app-guard';
            }
          }
        }
      }

      // Thread the workflow state into the context so agent tools
      // (createTask / listTasks / markTaskDone / writeArtifact) can read and
      // mutate `state.data._taskQueue` and `state.data._agent`. Also thread
      // the current planner-task id so citation captures can tag each URL
      // with the task that consulted it — that's what lets per-task
      // artifacts get their own focused Sources section.
      const contextForLLM = {
        ...context,
        _workflowState: state,
        _taskId: effectiveTaskId,
        // Carry the resolved model id so app-as-tool invocations (and any
        // other tools that want to mirror the operator's model choice)
        // can propagate it instead of falling back to the app's own
        // configured model.
        modelId: model?.id || null
      };

      // Build a step transcript so operators can audit exactly what the
      // agent saw and did at this step: the resolved prompts, the model,
      // the tools made available, every tool call with its args + result
      // preview, token usage, and which citations / skills the step
      // produced. Persisted to state.data._stepLogs[node.id] after the
      // LLM call returns; bubbled up from child sub-workflows.
      const citationsBefore = Array.isArray(state?.data?._citations)
        ? state.data._citations.length
        : 0;
      const skillsBefore = Object.keys(state?.data?._activatedSkills || {});
      const stepLog = {
        nodeId: node.id,
        kind: config?._isSynthesizer
          ? 'synthesizer'
          : config?._isPlannerTask || isDynamicTaskIteration
            ? 'planner-task'
            : 'prompt',
        taskId: effectiveTaskId,
        taskTitle: effectiveTaskTitle,
        startedAt: executeStartedAt.toISOString(),
        model: model?.id || null,
        // Truncate to keep state size sane — full prompts can be several
        // KB once templates and skills are folded in.
        messages: messages.map(m => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content.length > 6000
                ? `${m.content.slice(0, 6000)}…[truncated ${m.content.length - 6000} chars]`
                : m.content
              : m.content
        })),
        tools: tools.map(t => ({
          id: t.id || t.function?.name || null,
          description: t.description || t.function?.description || null
        })),
        // Sources the runtime pre-loaded into the system prompt for this
        // step. NOT tool calls — sources are injected as <sources>…</sources>
        // blocks. Recording them here is the only way the operator can see
        // which configured sources the agent actually saw.
        sources: stepSourceMetadata,
        // Apps the profile/node configured, with per-app registration
        // status. Apps that were registered show up as available tools
        // above; the value of THIS field is making the *missing* ones
        // visible — feature-flag-off, grounding-swap stripped, etc.
        apps: appsMetadata,
        toolCalls: []
      };
      // Record any tools that got dropped before the LLM call so operators
      // can see *why* their apps / function tools didn't run. The grounding
      // swap is the common case: on Gemini, configuring webSearch knocks
      // every other tool off the request because google_search can't be
      // combined with function calling.
      if (groundingSwapDropped && groundingSwapDropped.length > 0) {
        stepLog.groundingSwap = {
          from: 'webSearch + function tools',
          to: 'googleSearch (native grounding)',
          droppedToolIds: groundingSwapDropped,
          reason:
            'Google models cannot combine native googleSearch with function calling — function tools were not registered for this call.'
        };
      }
      if (droppedApps && droppedApps.length > 0) {
        stepLog.droppedApps = droppedApps;
      }
      contextForLLM._stepLog = stepLog;

      // Execute LLM call (with tool loop if tools are available)
      const response = await this.executeLLMWithTools({
        model,
        messages,
        tools,
        config,
        context: contextForLLM,
        nodeId: node.id
      });

      // Finalise the step transcript with timing + outcome.
      const stepCompletedMs = Date.now();
      stepLog.completedAt = new Date(stepCompletedMs).toISOString();
      stepLog.durationMs = executeStartMs ? stepCompletedMs - executeStartMs : null;
      stepLog.iterations = response.iterations || null;
      stepLog.tokens = response.tokens || null;
      stepLog.responseLength = typeof response.content === 'string' ? response.content.length : 0;
      const citationsAfter = Array.isArray(context._workflowState?.data?._citations)
        ? context._workflowState.data._citations.length
        : citationsBefore;
      stepLog.citationsAdded = Math.max(0, citationsAfter - citationsBefore);
      const skillsAfter = Object.keys(context._workflowState?.data?._activatedSkills || {});
      stepLog.skillsActivated = skillsAfter.filter(s => !skillsBefore.includes(s));

      // Parse output according to schema if defined
      let output = response.content;
      if (config.outputSchema) {
        output = this.parseStructuredOutput(response.content, config.outputSchema, node.id, {
          modelId: model.id,
          finishReason: response.finishReason,
          maxTokens: response.maxTokens
        });
        // Surface the parsed structured output on the step log so operators
        // can see the reviewer's verdict / memory-composer decision / etc in
        // the timeline. Without this, `output: null` made structured-output
        // nodes look like they returned nothing.
        //
        // The UI does `JSON.parse(stepLog.output)` on this string, so the
        // value MUST be valid JSON. `_previewToolValue` now produces a
        // JSON-parseable string for objects (it truncates long string
        // fields INSIDE the object before JSON.stringify, instead of
        // chopping the serialised string with a `…[truncated]` suffix
        // that breaks JSON.parse).
        try {
          stepLog.output = this._previewToolValue(output);
        } catch {
          // best effort — never fail a node on the preview helper
        }
      }

      this.logger.info('Agent node completed', {
        component: 'PromptNodeExecutor',
        nodeId: node.id,
        hasOutput: output !== undefined,
        model: model.id
      });

      // Build state updates (include source cache if sources were loaded)
      const stateUpdates = {
        ...(config.outputVariable ? { [config.outputVariable]: output } : {}),
        ...(cacheUpdates ? { _sourceContent: cacheUpdates } : {})
      };

      // ── Runtime-owned lifecycle: auto-persist task results and synthesizer
      // output. The LLM is no longer expected to call write_artifact or
      // mark_task_done — the runtime owns those operations now.
      const autoPersist = await this._autoPersistResult({
        node,
        config,
        output,
        response,
        state,
        context,
        agentProfile,
        executeStartedAt,
        executeStartMs,
        stepLog,
        effectiveTaskId,
        effectiveTaskTitle,
        effectiveLogKey,
        isDynamicTaskIteration
      });
      if (autoPersist?.stateUpdates) {
        Object.assign(stateUpdates, autoPersist.stateUpdates);
      }

      const hasStateUpdates = Object.keys(stateUpdates).length > 0;

      // Capture what we sent so the execution UI can show resolved
      // parameters. We truncate the rendered prompt content to keep the
      // persisted state from ballooning when a single prompt is hundreds
      // of KB (long contexts, embedded source documents, etc.).
      const renderedUserMessage = (() => {
        const userMsg = messages?.find?.(m => m?.role === 'user');
        if (!userMsg) return null;
        if (typeof userMsg.content === 'string') {
          return userMsg.content.length > 4000
            ? userMsg.content.slice(0, 4000) + '\n…[truncated]'
            : userMsg.content;
        }
        return userMsg.content;
      })();
      const resolvedInputs = {
        modelId: model.id,
        modelName: model.name,
        temperature: config.temperature ?? null,
        maxTokens: config.maxTokens ?? null,
        outputVariable: config.outputVariable ?? null,
        renderedPrompt: renderedUserMessage
      };

      // Build result with model info and token usage for UI display
      const result = this.createSuccessResult(
        {
          content: output,
          model: model.id,
          modelName: model.name,
          iterations: response.iterations,
          tokens: response.tokens
        },
        { stateUpdates: hasStateUpdates ? stateUpdates : undefined, resolvedInputs }
      );

      // Promote model + token info to the top of the result so the persisted
      // state exposes them to the UI.
      result.tokens = response.tokens;
      result.model = model.id;
      result.modelName = model.name;
      result.content = output;

      // Surface the outputVariable name (UI hint). The value itself is
      // applied to state via stateUpdates above — no need to also embed
      // it as `result.output`, which only duplicated `result.content`.
      if (config.outputVariable) {
        result.outputVariable = config.outputVariable;
      }

      return result;
    } catch (error) {
      this.logger.error('Agent node failed', {
        component: 'PromptNodeExecutor',
        nodeId: node.id,
        error
      });

      return this.createErrorResult(`Agent execution failed: ${error.message}`, {
        nodeId: node.id,
        originalError: error.message
      });
    }
  }

  /**
   * Build LLM messages from config and state.
   *
   * Supports file data via the `inputFiles` config option. When specified,
   * referenced state variables containing file data objects are processed:
   * - Text files (PDF, DOCX, etc.): prepended as `[File: name (type)]\n\ncontent`
   * - Images: added as multimodal content parts with base64 data
   *
   * @param {Object} config - Agent configuration
   * @param {Object} state - Workflow state
   * @param {Object} context - Execution context
   * @returns {Array<Object>} Array of message objects
   * @private
   */
  buildMessages(config, state, context, model = null) {
    const messages = [];
    const language = context?.language || 'en';
    const modelSupportsVision = !!(model && (model.supportsVision || model.supportsImages));

    // Add system message if configured
    if (config.system) {
      const systemTemplate = this.getLocalizedValue(config.system, language);
      let systemContent = this.resolveTemplateVariables(systemTemplate, state);

      // Agent runs auto-include the profile memory file body (if enabled).
      // `context._agentMemoryBlock` is populated by execute() before
      // buildMessages so we keep this synchronous.
      if (context._agentMemoryBlock) {
        systemContent += `\n\n${context._agentMemoryBlock}`;
      }

      // Agent runs also auto-include skills context: <available_skills>
      // metadata + <active_skill> full bodies for activated ones. Both are
      // pre-rendered in execute() and attached to context.
      if (context._agentSkillsBlock) {
        systemContent += `\n\n${context._agentSkillsBlock}`;
      }

      // Inject source content into system prompt if available
      if (context.sourceContent) {
        const hasSourcesPlaceholder = systemContent.includes('{{sources}}');
        const hasSourcePlaceholder = systemContent.includes('{{source}}');

        if (hasSourcesPlaceholder) {
          systemContent = systemContent.replace('{{sources}}', context.sourceContent);
        }
        if (hasSourcePlaceholder) {
          systemContent = systemContent.replace('{{source}}', context.sourceContent);
        }
        if (!hasSourcesPlaceholder && !hasSourcePlaceholder) {
          systemContent += `\n\nSources:\n<sources>${context.sourceContent}</sources>`;
        }
      }

      messages.push({
        role: 'system',
        content: systemContent
      });
    }

    // Include conversation history if configured
    if (config.includeHistory && state.conversationHistory) {
      messages.push(...state.conversationHistory);
    }

    // Build user message from prompt or state input
    let userContent;
    if (config.prompt) {
      const promptTemplate = this.getLocalizedValue(config.prompt, language);
      userContent = this.resolveTemplateVariables(promptTemplate, state);
    } else if (state.data?.input) {
      userContent = state.data.input;
    } else if (state.data?.message) {
      userContent = state.data.message;
    } else if (state.data?.brief) {
      // Agent runs land the operator's brief here; use it as a last-resort
      // user message so providers that require one (e.g. Bedrock) don't 400.
      userContent = state.data.brief;
    } else if (state.data?._planGoal) {
      userContent = state.data._planGoal;
    }

    // Append user hint from chat (e.g., "@document-analysis take care" → "take care")
    if (state.data?._userHint && userContent) {
      userContent += `\n\nUser instruction: ${state.data._userHint}`;
    }

    // Process inputFiles: inject file data from state into the user message
    if (config.inputFiles && Array.isArray(config.inputFiles) && userContent) {
      const fileParts = [];
      const imageParts = [];

      for (const varName of config.inputFiles) {
        const raw = state.data?.[varName] || state.data?._fileData;
        logger.info('inputFiles lookup', {
          component: 'PromptNodeExecutor',
          varName,
          rawType: typeof raw,
          isObject: raw && typeof raw === 'object',
          hasContent: !!(raw && raw.content),
          hasPageImages: !!(raw && Array.isArray(raw.pageImages) && raw.pageImages.length > 0),
          pageImagesCount: raw?.pageImages?.length || 0,
          hasFileName: !!(raw && raw.fileName),
          stateDataKeys: Object.keys(state.data || {}).join(', ')
        });
        if (!raw || typeof raw !== 'object') continue;

        // Ensure we have a file data object (not a plain string from text mapping)
        const fileData = raw;

        if (fileData.type === 'image' && fileData.base64) {
          // Image file: only attach if the model can see images. Otherwise
          // we'd be silently shipping bytes the model will refuse or hallucinate
          // around.
          if (modelSupportsVision) {
            imageParts.push({
              base64: fileData.base64,
              fileType: fileData.fileType || 'image/jpeg'
            });
          } else {
            const fileName = fileData.fileName || varName;
            const fileType = fileData.displayType || fileData.fileType || 'unknown';
            fileParts.push(
              `[File: ${fileName} (${fileType})]\n\nNote: This is an image file but the selected model does not support vision input. The image was not attached.\n`
            );
            this.logger.warn('Skipping image attachment — model lacks vision support', {
              component: 'PromptNodeExecutor',
              modelId: model?.id,
              fileName
            });
          }
        } else if (fileData.content) {
          // Text-based file (PDF, DOCX, etc.): prepend as text
          const fileName = fileData.fileName || varName;
          const fileType = fileData.displayType || fileData.fileType || 'unknown';
          fileParts.push(`[File: ${fileName} (${fileType})]\n\n${fileData.content}\n`);
        } else if (Array.isArray(fileData.pageImages) && fileData.pageImages.length > 0) {
          // Image-based PDF with rendered page images
          const fileName = fileData.fileName || varName;
          const fileType = fileData.displayType || fileData.fileType || 'unknown';
          if (modelSupportsVision) {
            fileParts.push(
              `[File: ${fileName} (${fileType})] - ${fileData.pageImages.length} page(s) rendered as images:\n`
            );
            for (const img of fileData.pageImages) {
              imageParts.push({ base64: img, fileType: 'image/jpeg' });
            }
          } else {
            fileParts.push(
              `[File: ${fileName} (${fileType})]\n\nNote: ${fileData.pageImages.length} page(s) were rendered as images, but the selected model does not support vision input. The images were not attached and no text content could be extracted from this file.\n`
            );
            this.logger.warn('Skipping page images — model lacks vision support', {
              component: 'PromptNodeExecutor',
              modelId: model?.id,
              fileName,
              pageImageCount: fileData.pageImages.length
            });
          }
        } else if (fileData.fileName) {
          // File uploaded but content extraction failed (e.g., scanned/image-based PDF)
          const fileName = fileData.fileName || varName;
          const fileType = fileData.displayType || fileData.fileType || 'unknown';
          fileParts.push(
            `[File: ${fileName} (${fileType})]\n\nNote: No text content could be extracted from this file. It may be a scanned document or image-based PDF.\n`
          );
        }
      }

      if (imageParts.length > 0) {
        // Build message with imageData property (adapters handle provider-specific formatting)
        const textContent =
          fileParts.length > 0 ? fileParts.join('\n') + '\n' + userContent : userContent;

        messages.push({
          role: 'user',
          content: textContent,
          imageData: imageParts
        });
        return messages;
      } else if (fileParts.length > 0) {
        // Text files only: prepend file content to user message
        userContent = fileParts.join('\n') + '\n' + userContent;
      }
    }

    if (userContent) {
      messages.push({
        role: 'user',
        content: userContent
      });
    }

    return messages;
  }

  /**
   * Get localized value from a string or localized object.
   *
   * @param {string|Object} value - String or {en: "...", de: "..."} object
   * @param {string} language - Language code
   * @returns {string} Localized string value
   * @private
   */
  getLocalizedValue(value, language) {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      return value[language] || value['en'] || Object.values(value)[0] || '';
    }
    return String(value || '');
  }

  /**
   * Resolve template variables in a string.
   * Supports multiple syntaxes:
   * - {{variable}} - Simple Handlebars-style (looks up in state.data)
   * - {{#if condition}}...{{/if}} - Simple conditional blocks
   * - {{#each array}}...{{/each}} - Loop over arrays
   * - {{@index}} - Current loop index (0-based)
   * - {{this}} and {{this.property}} - Current item reference
   * - {{#compare val1 "op" val2}}...{{/compare}} - Comparison blocks
   * - $.path - JSONPath-style (via resolveVariables)
   * - ${$.path} - Embedded JSONPath-style (via resolveVariables)
   *
   * @param {string} template - Template string
   * @param {Object} state - Workflow state
   * @returns {string} Resolved template
   * @private
   */
  resolveTemplateVariables(template, state) {
    if (typeof template !== 'string') {
      return template;
    }

    let result = template;

    // Handle {{#each array}}...{{/each}} blocks with proper nesting support
    // Process from outermost to innermost using balanced matching
    result = this.processEachBlocks(result, state);

    // Handle {{#compare val1 "op" val2}}...{{/compare}} blocks
    // Supports operators: <, >, <=, >=, ==, !=
    result = result.replace(
      /\{\{#compare\s+([^\s"]+)\s+"([^"]+)"\s+([^\s}]+)\s*\}\}([\s\S]*?)\{\{\/compare\}\}/g,
      (match, left, operator, right, content) => {
        // Resolve left value - could be a variable path or literal
        let leftVal = this.getNestedValue(left.trim(), state.data || {});
        if (leftVal === undefined) {
          // Treat as literal if not found in state
          leftVal = left.trim();
        }

        // Resolve right value - could be a variable path or literal
        let rightVal = this.getNestedValue(right.trim(), state.data || {});
        if (rightVal === undefined) {
          // Treat as literal if not found in state
          rightVal = right.trim();
        }

        let comparisonResult = false;

        switch (operator) {
          case '<':
            comparisonResult = Number(leftVal) < Number(rightVal);
            break;
          case '>':
            comparisonResult = Number(leftVal) > Number(rightVal);
            break;
          case '<=':
            comparisonResult = Number(leftVal) <= Number(rightVal);
            break;
          case '>=':
            comparisonResult = Number(leftVal) >= Number(rightVal);
            break;
          case '==':
            comparisonResult = leftVal == rightVal;
            break;
          case '===':
            comparisonResult = leftVal === rightVal;
            break;
          case '!=':
            comparisonResult = leftVal != rightVal;
            break;
          case '!==':
            comparisonResult = leftVal !== rightVal;
            break;
          default:
            this.logger.warn('Unknown comparison operator', {
              component: 'PromptNodeExecutor',
              operator
            });
        }

        return comparisonResult ? this.resolveTemplateVariables(content, state) : '';
      }
    );

    // Handle {{#if condition}}...{{/if}} blocks
    result = result.replace(
      /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (match, condition, content) => {
        // Resolve the condition variable
        const conditionValue = this.getNestedValue(condition.trim(), state.data || {});
        if (conditionValue) {
          // Recursively resolve variables in the content
          return this.resolveTemplateVariables(content, state);
        }
        return '';
      }
    );

    // Handle simple {{variable}} or {{path.to.value}} substitution
    // Exclude @index and this which are handled in each loops
    result = result.replace(/\{\{([^#/@}][^}]*)\}\}/g, (match, variable) => {
      const trimmed = variable.trim();

      // Skip 'this' references outside of each loops (they should be empty)
      if (trimmed === 'this' || trimmed.startsWith('this.')) {
        return '';
      }

      // Special template variable populated by the runtime — formats the
      // accumulated planner task results into a markdown block so the
      // synthesizer (and intermediate plan tasks) can see prior work.
      if (trimmed === 'previousTaskResults') {
        return this._formatPreviousTaskResults(state);
      }

      // Citations ledger collected from every search/extract tool call
      // during the run. Renders a numbered list `[1] title — url` that the
      // synthesizer cites inline. Named `citations` (NOT `sources`) so it
      // doesn't collide with `profile.sources` — the configured knowledge
      // bases the agent can look up via `source_*` tools. Citations are
      // the runtime ledger of URLs the agent actually consulted; sources
      // is the configured catalog it could consult.
      if (trimmed === 'citations') {
        return this._formatCitations(state);
      }

      // Inbox item — render clean. The state object stores the FULL parsed
      // checklist line in `.raw`, which accumulates `-- done by …` notes
      // every time the item gets re-checked. Stringifying the whole object
      // bleeds that history (including prior hallucinated reports) into the
      // current run's prompts and the synthesizer's final report. Render
      // just `(P1) text` so the LLM sees what the user actually wrote.
      if (trimmed === 'currentInboxItem') {
        const item = state?.data?.currentInboxItem;
        if (!item) return '';
        if (typeof item === 'string') return item;
        const text = (item.text || '').toString().trim();
        if (!text) return '';
        const priority =
          item.priority && item.priority !== 'unprioritized'
            ? `(${item.priority.toUpperCase()}) `
            : '';
        return `${priority}${text}`;
      }

      const value = this.getNestedValue(trimmed, state.data || {});
      if (value !== undefined && value !== null) {
        // Convert objects to JSON string to avoid [object Object]
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return String(value);
      }
      return ''; // Remove unresolved variables
    });

    // Finally, handle $.path syntax via existing resolveVariables
    result = this.resolveVariables(result, state);

    return result;
  }

  /**
   * Get a nested value from an object using dot notation.
   *
   * @param {string} path - Dot-notation path like "user.name" or "items.0.id"
   * @param {Object} obj - Object to search
   * @returns {*} Value at path or undefined
   * @private
   */
  getNestedValue(path, obj) {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Process {{#each}}...{{/each}} blocks with proper nesting support.
   * Uses balanced matching to correctly handle nested loops.
   *
   * @param {string} template - Template string to process
   * @param {Object} state - Workflow state
   * @returns {string} Processed template
   * @private
   */
  processEachBlocks(template, state) {
    let result = template;
    let iterations = 0;
    const maxIterations = 20; // Prevent infinite loops

    // Process from outermost to innermost
    // Find the first {{#each ...}} and its matching {{/each}} with balanced nesting
    while (iterations < maxIterations) {
      iterations++;

      const startMatch = result.match(/\{\{#each\s+([^}]+)\}\}/);
      if (!startMatch) {
        break; // No more each blocks
      }

      const startIndex = startMatch.index;
      const arrayPath = startMatch[1].trim();
      const afterOpenTag = startIndex + startMatch[0].length;

      // Find the matching closing tag with balanced nesting
      let depth = 1;
      let searchPos = afterOpenTag;
      let closingIndex = -1;

      while (depth > 0 && searchPos < result.length) {
        const nextOpen = result.indexOf('{{#each', searchPos);
        const nextClose = result.indexOf('{{/each}}', searchPos);

        if (nextClose === -1) {
          // No closing tag found - malformed template
          break;
        }

        if (nextOpen !== -1 && nextOpen < nextClose) {
          // Found another opening tag before the closing tag
          depth++;
          searchPos = nextOpen + 7; // Move past "{{#each"
        } else {
          // Found closing tag
          depth--;
          if (depth === 0) {
            closingIndex = nextClose;
          }
          searchPos = nextClose + 9; // Move past "{{/each}}"
        }
      }

      if (closingIndex === -1) {
        // Couldn't find matching closing tag
        this.logger.warn('Unbalanced {{#each}} block', {
          component: 'PromptNodeExecutor',
          arrayPath
        });
        break;
      }

      // Extract the content between opening and closing tags
      const content = result.substring(afterOpenTag, closingIndex);
      const fullMatch = result.substring(startIndex, closingIndex + 9);

      // Get the array to iterate over
      const array = this.getNestedValue(arrayPath, state.data || {});

      let replacement = '';
      if (Array.isArray(array) && array.length > 0) {
        replacement = array
          .map((item, index) => {
            let itemContent = content;

            // Replace {{@index}} with current index
            itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));

            // Replace {{this.property}} with item.property
            itemContent = itemContent.replace(/\{\{this\.([^}]+)\}\}/g, (_, prop) => {
              const propPath = prop.trim();
              const val = this.getNestedValue(propPath, item);
              if (val !== undefined && val !== null) {
                return typeof val === 'object' ? JSON.stringify(val) : String(val);
              }
              return '';
            });

            // Replace {{this}} with JSON of item
            itemContent = itemContent.replace(/\{\{this\}\}/g, () => {
              return typeof item === 'object' ? JSON.stringify(item) : String(item);
            });

            // Recursively process any nested each blocks in this iteration
            itemContent = this.processEachBlocks(itemContent, state);

            return itemContent;
          })
          .join('');
      }

      // Replace the full match with the processed content
      result = result.substring(0, startIndex) + replacement + result.substring(closingIndex + 9);
    }

    return result;
  }

  /**
   * Get model configuration by ID or use default.
   *
   * Priority order:
   * 1. Model specified in node config (config.modelId)
   * 2. Model override from initial data (_modelOverride)
   * 3. Workflow-level defaultModelId from workflow config
   * 4. Model from execution context
   * 5. Default model
   *
   * @param {string} modelId - Model ID from node config or null
   * @param {Object} context - Execution context
   * @param {Object} state - Current workflow state
   * @returns {Promise<Object|null>} Model configuration or null
   * @private
   */
  async getModel(modelId, context, state) {
    const { data: models } = configCache.getModels();
    if (!models) {
      return null;
    }

    // 1. Use model from node config if specified. If the configured model
    //    isn't in the enabled set (e.g. its id was wiped/changed), fall
    //    through to the durable fallbacks below rather than failing the node.
    if (modelId) {
      const configured = models.find(m => m.id === modelId);
      if (configured) return configured;
    }

    // 2. Check for model override from initial data (user selection at start)
    const modelOverride = state?.data?._modelOverride;
    if (modelOverride) {
      const overrideModel = models.find(m => m.id === modelOverride);
      if (overrideModel) {
        return overrideModel;
      }
    }

    // 3. Check workflow-level defaultModelId, then the DURABLE per-run agent
    //    model config (state survives the config-cache TTL refresh that wipes
    //    the runtime-applied workflow.config.defaultModelId).
    const workflowDefaultModelId =
      context.workflow?.config?.defaultModelId || this.resolveConfiguredModelId(state);
    if (workflowDefaultModelId) {
      const workflowModel = models.find(m => m.id === workflowDefaultModelId);
      if (workflowModel) {
        return workflowModel;
      }
    }

    // 4. Use context model if available
    if (context.modelId) {
      return models.find(m => m.id === context.modelId);
    }

    // 5. Fall back to default model
    return models.find(m => m.default) || models[0];
  }

  /**
   * Get tools available to this agent.
   *
   * @param {Array<string>} toolIds - List of tool IDs
   * @param {string} language - Language for localization
   * @param {Object} _context - Execution context (reserved for future use)
   * @returns {Promise<Array>} Array of tool configurations
   * @private
   */
  async getAgentTools(toolIds, language, _context) {
    // Create a minimal app config for getToolsForApp
    const appConfig = {
      tools: toolIds,
      sources: _context.appConfig?.sources || []
    };

    const toolContext = {
      user: _context.user,
      chatId: _context.chatId,
      enabledTools: toolIds
    };

    return await getToolsForApp(appConfig, language, toolContext);
  }

  /**
   * Load source content for this agent node.
   *
   * Sources can be defined at node level (config.sources) or workflow level
   * (context.workflow.sources). Node-level sources take precedence.
   * Content is cached in state.data._sourceContent to avoid redundant loading
   * when multiple agent nodes reference the same sources.
   *
   * @param {Object} nodeConfig - Agent node configuration
   * @param {Object} state - Workflow state
   * @param {Object} context - Execution context
   * @returns {Promise<{content: string|null, cacheUpdates: Object|null}>} Source content and cache updates
   * @private
   */
  async loadSourceContent(nodeConfig, state, context) {
    // Determine which sources to load (node-level overrides workflow-level)
    const sourceIds = nodeConfig.sources || context.workflow?.sources;
    if (!sourceIds || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return { content: null, cacheUpdates: null, sourcesMetadata: [] };
    }

    // Check cache in state first (keyed by sorted source IDs)
    const cacheKey = [...sourceIds].sort().join(',');
    const cachedContent = state.data?._sourceContent?.[cacheKey];
    if (cachedContent) {
      this.logger.debug('Using cached source content', {
        component: 'PromptNodeExecutor',
        sourceIds
      });
      return {
        content: cachedContent,
        cacheUpdates: null,
        sourcesMetadata: sourceIds.map(id => ({ id, status: 'cached' }))
      };
    }

    try {
      // Resolve source references to configurations
      const sourceResolutionService = new SourceResolutionService();
      const fakeApp = { id: context.workflow?.id || 'workflow', sources: sourceIds };
      const sourceContext = {
        user: context.user,
        chatId: context.executionId,
        language: context.language
      };

      const resolvedSources = await sourceResolutionService.resolveAppSources(
        fakeApp,
        sourceContext
      );

      const resolvedIds = new Set(
        Array.isArray(resolvedSources) ? resolvedSources.map(s => s?.id).filter(Boolean) : []
      );

      if (resolvedSources.length === 0) {
        return {
          content: null,
          cacheUpdates: null,
          sourcesMetadata: sourceIds.map(id => ({ id, status: 'unresolved' }))
        };
      }

      // Load content from resolved sources
      const sourceManager = createSourceManager({
        filesystem: {
          basePath: path.resolve(getRootDir(), config.CONTENTS_DIR)
        }
      });

      const result = await sourceManager.loadSources(resolvedSources, sourceContext);

      if (result.metadata.errors.length > 0) {
        this.logger.warn('Source loading errors', {
          component: 'PromptNodeExecutor',
          errors: result.metadata.errors
        });
      }

      // Build per-source metadata for the step log. We can only see byte
      // counts at the aggregate level via result.metadata, so per-source
      // size is approximate; status however is precise.
      const errorIds = new Set(
        Array.isArray(result?.metadata?.errors)
          ? result.metadata.errors.map(e => e?.sourceId || e?.id).filter(Boolean)
          : []
      );
      const totalBytes =
        typeof result?.content === 'string' ? Buffer.byteLength(result.content, 'utf8') : 0;
      const loadedIds = sourceIds.filter(id => resolvedIds.has(id) && !errorIds.has(id));
      const perSourceBytes = loadedIds.length > 0 ? Math.round(totalBytes / loadedIds.length) : 0;
      const sourcesMetadata = sourceIds.map(id => {
        if (errorIds.has(id)) return { id, status: 'error' };
        if (!resolvedIds.has(id)) return { id, status: 'unresolved' };
        return { id, status: 'loaded', bytesApprox: perSourceBytes };
      });

      // Return content and cache updates for state persistence
      const existingCache = state.data?._sourceContent || {};
      const cacheUpdates = result.content ? { ...existingCache, [cacheKey]: result.content } : null;

      return { content: result.content || null, cacheUpdates, sourcesMetadata };
    } catch (error) {
      this.logger.error('Failed to load sources', {
        component: 'PromptNodeExecutor',
        sourceIds,
        error
      });
      return {
        content: null,
        cacheUpdates: null,
        sourcesMetadata: sourceIds.map(id => ({ id, status: 'error', error: error.message }))
      };
    }
  }

  /**
   * Execute LLM call with tool loop.
   *
   * This method handles the iterative process of:
   * 1. Calling the LLM
   * 2. Checking for tool calls
   * 3. Executing tools
   * 4. Adding tool results to messages
   * 5. Repeating until no more tool calls or max iterations reached
   *
   * @param {Object} params - Execution parameters
   * @returns {Promise<Object>} Final response with content
   * @private
   */
  async executeLLMWithTools({ model, messages, tools, config, context, nodeId }) {
    // Budget-driven continuation (Claude Code TOKEN_BUDGET analog). The agent
    // runs as long as the task and budget require, rather than a fixed count.
    // `maxToolRoundsPerNode` is a safety backstop above the token budget; the
    // token budget is what actually shapes when the agent wraps up.
    const budgets = context._agentProfile?.budgets || {};
    const roundCap = config.maxIterations || budgets.maxToolRoundsPerNode || this.maxIterations;
    const maxTokensPerRun = budgets.maxTokensPerRun || 0; // 0 = unlimited
    const maxIterations = roundCap;
    const temperature = config.temperature ?? 0.7;
    const maxTokens = config.maxTokens || model.maxOutputTokens || 4096;
    const language = context.language || 'en';

    // Run-level token spend lives on the workflow state so the budget spans
    // every node/iteration of the whole run, not just this node.
    const runState = context._workflowState;
    const runBudget = runState?.data?._budget || { input: 0, output: 0, total: 0 };
    if (runState?.data) runState.data._budget = runBudget;

    let currentMessages = [...messages];
    let iteration = 0;
    let finalContent = '';
    let finalFinishReason = null;
    // When the run token budget is exhausted we stop offering tools and ask the
    // model for a final answer instead of continuing to call tools.
    let forceFinish = false;
    // Reactive context recovery (Claude Code reactive-compact analog): bounded
    // number of microcompact-and-retry attempts when a request overflows.
    let reactiveAttempts = 0;
    const MAX_REACTIVE_ATTEMPTS = 2;
    // Accumulate token usage across iterations
    const totalTokens = { input: 0, output: 0 };

    // Verify API key using centralized helper
    const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
    if (!apiKeyResult.success) {
      throw new Error(apiKeyResult.error?.message || 'API key verification failed');
    }
    const apiKey = apiKeyResult.apiKey;

    while (iteration < maxIterations) {
      iteration++;

      this.logger.debug('LLM iteration', {
        component: 'PromptNodeExecutor',
        nodeId,
        iteration,
        messageCount: currentMessages.length
      });

      // When the node declares `outputSchema`, forward it to the LLM as
      // `responseSchema` so adapters that support native structured output
      // (Google Gemini sets `generationConfig.response_schema`; OpenAI uses
      // `response_format.json_schema`) force the model to emit conformant
      // JSON instead of free-form prose. Without this we rely on
      // post-response parsing in `parseStructuredOutput`, which fails when
      // the LLM wraps the JSON in unexpected ways or adds explanatory
      // prose — the source of "Could not parse structured output" warnings.
      const responseSchema = config.outputSchema || undefined;
      const responseFormat = responseSchema ? 'json' : undefined;

      // Execute the request using the helper (filters invalid options like user, chatId).
      // On a context-overflow error, microcompact the in-loop messages and
      // retry the same iteration (reactive recovery) before giving up.
      let response;
      try {
        response = await this.llmHelper.executeStreamingRequest({
          model,
          messages: currentMessages,
          apiKey,
          options: {
            temperature,
            maxTokens,
            tools: tools.length > 0 && !forceFinish ? tools : undefined,
            responseSchema,
            responseFormat
            // Note: user and chatId are intentionally NOT passed here
            // They are not valid adapter options and would corrupt provider request bodies
          },
          language
        });
      } catch (err) {
        if (
          ContextSummarizer.isContextOverflowError(err) &&
          reactiveAttempts < MAX_REACTIVE_ATTEMPTS
        ) {
          const mc = this.contextSummarizer.microcompactMessages(currentMessages, {
            keepRecent: 4
          });
          if (mc.freedChars > 0) {
            reactiveAttempts++;
            currentMessages = mc.messages;
            this.logger.warn('Reactive context recovery: microcompacted messages, retrying', {
              component: 'PromptNodeExecutor',
              nodeId,
              attempt: reactiveAttempts,
              freedChars: mc.freedChars,
              collapsed: mc.collapsed
            });
            iteration--; // don't charge the failed attempt against the round cap
            continue;
          }
        }
        throw err;
      }

      // Accumulate content
      if (response.content) {
        finalContent += response.content;
      }

      // Track the last iteration's finishReason — when the loop breaks
      // (no more tool calls), this is the model's actual stop reason and
      // signals whether the output was truncated by the token cap.
      if (response.finishReason) {
        finalFinishReason = response.finishReason;
      }

      // When responseSchema is set, the Anthropic adapter implements structured
      // output by forcing a synthetic `json` tool call (since Anthropic has no
      // native response_format JSON schema). The LLM's reply arrives as a
      // tool_use block, not as content. Lift its arguments into finalContent so
      // downstream parseStructuredOutput sees the JSON, and drop the synthetic
      // call so the tool-execution loop below doesn't try to run a tool that
      // doesn't exist.
      if (responseSchema && response.toolCalls?.length > 0) {
        const jsonCall = response.toolCalls.find(tc => tc.function?.name === 'json');
        if (jsonCall?.function?.arguments) {
          finalContent += jsonCall.function.arguments;
          response.toolCalls = response.toolCalls.filter(tc => tc !== jsonCall);
        }
      }

      // Capture Gemini native grounding metadata (googleSearch). Unlike
      // function-calling tools, grounding doesn't appear in the tool-call
      // loop — the URLs ride alongside the assistant message. Push each
      // grounding chunk into the run's _citations ledger so the
      // synthesizer can cite them just like any other web/source result.
      if (response.groundingMetadata) {
        try {
          await this._captureCitationsFromGroundingMetadata({
            groundingMetadata: response.groundingMetadata,
            state: context._workflowState,
            taskId: context._taskId || null
          });
        } catch (gErr) {
          this.logger.warn('Grounding citation capture failed', {
            component: 'PromptNodeExecutor',
            error: gErr.message
          });
        }
      }

      // Accumulate token usage from response (or estimate if not provided).
      // Track the per-iteration delta so it can be added to the run budget.
      let deltaIn = 0;
      let deltaOut = 0;
      if (response.usage) {
        deltaIn = response.usage.prompt_tokens || response.usage.input_tokens || 0;
        deltaOut = response.usage.completion_tokens || response.usage.output_tokens || 0;
      } else {
        // Fallback: estimate tokens when usage data is not provided (streaming responses)
        // This matches the approach used in StreamingHandler for chat apps
        const inputText = currentMessages.map(m => m.content || '').join(' ');
        deltaIn = estimateTokens(inputText);
        if (response.content) {
          deltaOut = estimateTokens(response.content);
        }
      }
      totalTokens.input += deltaIn;
      totalTokens.output += deltaOut;
      runBudget.input += deltaIn;
      runBudget.output += deltaOut;
      runBudget.total = runBudget.input + runBudget.output;

      // Check if there are tool calls to process
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No tool calls, we're done
        break;
      }

      // If we already forced a finish but the model still tried to call tools,
      // stop here rather than looping forever without tools available.
      if (forceFinish) {
        finalFinishReason = 'budget_exhausted';
        break;
      }

      // Process tool calls
      const assistantMessage = {
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls
      };
      // Preserve thoughtSignatures for Gemini 3 thinking models (required for multi-turn tool calling)
      if (response.thoughtSignatures?.length > 0) {
        assistantMessage.thoughtSignatures = response.thoughtSignatures;
      }
      currentMessages.push(assistantMessage);

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        const toolResult = await this.executeToolCall(toolCall, tools, context);
        currentMessages.push(toolResult);
      }

      // Budget gate: if the run has spent its token budget, answer this round's
      // tool calls (done above) then nudge the model to wrap up — one final
      // tool-less turn produces the answer instead of more tool calls.
      if (maxTokensPerRun > 0 && runBudget.total >= maxTokensPerRun && !forceFinish) {
        forceFinish = true;
        this.logger.info('Run token budget reached — nudging agent to wrap up', {
          component: 'PromptNodeExecutor',
          nodeId,
          spent: runBudget.total,
          maxTokensPerRun
        });
        currentMessages.push({
          role: 'user',
          content:
            `[system] Token budget for this run is exhausted (${runBudget.total}/${maxTokensPerRun}). ` +
            `Stop calling tools. Produce your best final answer now using what you already have. ` +
            `Be concise and note any gaps you could not close.`
        });
      }

      // Round-cap gate: spend the LAST allowed round producing the final output
      // instead of one more tool call. Without this, a model that keeps calling
      // tools until the cap exits the loop having only emitted interim narration
      // ("I'll research… let me dig deeper") — never the actual deliverable
      // (agent) or the verdict JSON (verifier, which runs through this same
      // loop). Disabling tools on the final round forces a text answer.
      if (!forceFinish && iteration >= maxIterations - 1) {
        forceFinish = true;
        this.logger.info('Tool-round cap reached — forcing a final answer', {
          component: 'PromptNodeExecutor',
          nodeId,
          iteration,
          maxIterations
        });
        currentMessages.push({
          role: 'user',
          content:
            '[system] You have reached the tool-use round limit for this step. Do NOT call any ' +
            'more tools. Using everything you have gathered so far, produce your COMPLETE final ' +
            'response now, in full, exactly as instructed — not a summary of what you did. If ' +
            'some details are missing, state them briefly but still deliver the best complete ' +
            'answer you can.'
        });
      }

      // Continue to next iteration
    }

    if (iteration >= maxIterations) {
      this.logger.warn('Max tool rounds reached for node', {
        component: 'PromptNodeExecutor',
        nodeId,
        maxIterations,
        runTokens: runBudget.total
      });
      if (!finalFinishReason) finalFinishReason = 'max_iterations';
    }

    return {
      content: finalContent,
      iterations: iteration,
      tokens: totalTokens,
      runTokens: runBudget.total,
      budgetExhausted: forceFinish,
      finishReason: finalFinishReason,
      maxTokens
    };
  }

  /**
   * Execute a single tool call.
   *
   * @param {Object} toolCall - Tool call object from LLM
   * @param {Array} tools - Available tools
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Tool result message
   * @private
   */
  async executeToolCall(toolCall, tools, context) {
    const { user, chatId, appConfig } = context;
    const requestedName = toolCall.function?.name;

    // Strict allowlist: the LLM may emit a name that doesn't correspond to any
    // registered tool (chain-of-thought leakage, hallucinated tool ids, or a
    // provider quirk that slipped past the converter sanitizer). Do NOT fall
    // back to the raw name and dispatch — instead, hand the model a clear
    // error so it can self-correct. The run continues; the iteration cap
    // bounds runaway behavior.
    const matchedTool = tools.find(
      t => t.id === requestedName || normalizeToolName(t.id) === requestedName
    );

    if (!matchedTool) {
      const availableToolIds = tools.map(t => t.id);
      this.logger.error('Agent attempted to call an unregistered tool', {
        component: 'PromptNodeExecutor',
        requestedName:
          typeof requestedName === 'string' && requestedName.length > 200
            ? `${requestedName.slice(0, 200)}…(${requestedName.length})`
            : requestedName,
        availableTools: availableToolIds,
        executionId: context.executionId
      });

      // Record the attempt in workflow state for the UI to render.
      const ws = context._workflowState;
      if (ws && ws.data) {
        if (!Array.isArray(ws.data._toolErrors)) ws.data._toolErrors = [];
        ws.data._toolErrors.push({
          ts: new Date().toISOString(),
          requestedName:
            typeof requestedName === 'string' && requestedName.length > 200
              ? `${requestedName.slice(0, 200)}…(${requestedName.length})`
              : requestedName,
          availableTools: availableToolIds,
          reason: 'not_registered'
        });
      }

      // Emit a workflow event so AgentRunDetailPage's SSE stream sees it.
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.tool.hallucinated',
          chatId,
          executionId: context.executionId,
          requestedName,
          availableTools: availableToolIds
        });
      } catch (_err) {
        // never fail a tool call because of telemetry
      }

      const safeMessage = `Tool '${typeof requestedName === 'string' ? requestedName.slice(0, 80) : String(requestedName)}' is not registered for this agent. Available tools: ${availableToolIds.join(', ') || '(none)'}. Pick one of those or stop calling tools.`;
      // Record hallucinated tool attempts so the audit shows what the
      // model tried to do — important for trust analysis.
      if (context._stepLog && Array.isArray(context._stepLog.toolCalls)) {
        context._stepLog.toolCalls.push({
          name: typeof requestedName === 'string' ? requestedName : 'unknown',
          error: 'hallucinated',
          message: safeMessage
        });
      }
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: typeof requestedName === 'string' ? requestedName : 'unknown',
        content: JSON.stringify({
          error: true,
          reason: 'tool_not_registered',
          message: safeMessage
        })
      };
    }

    const toolId = matchedTool.id;

    // Parse arguments. Gemini (and occasionally other providers) sometimes
    // emits tool args with extra content after the closing brace — e.g.
    // `{"message":"…"}{"message":"…"}` from streaming fragments that
    // weren't merged cleanly. Strict JSON.parse rejects that, leaves args
    // empty, and the app gets invoked with no input. Try strict parse first;
    // on failure, walk the string to extract the first balanced JSON object.
    let args = {};
    if (toolCall.function.arguments) {
      const raw = toolCall.function.arguments;
      try {
        args = JSON.parse(raw);
      } catch (strictErr) {
        const prefix = this._extractFirstJsonObject(raw);
        if (prefix !== null) {
          try {
            args = JSON.parse(prefix);
            this.logger.warn('Recovered tool arguments from malformed JSON prefix', {
              component: 'PromptNodeExecutor',
              toolId,
              originalLength: raw.length,
              parsedLength: prefix.length
            });
          } catch (lenientErr) {
            this.logger.warn('Failed to parse tool arguments (lenient also failed)', {
              component: 'PromptNodeExecutor',
              toolId,
              strictError: strictErr.message,
              lenientError: lenientErr.message
            });
          }
        } else {
          this.logger.warn('Failed to parse tool arguments', {
            component: 'PromptNodeExecutor',
            toolId,
            error: strictErr
          });
        }
      }
    }

    // App-as-tool synthetic dispatch: handled by gateway, not by global runTool.
    if (typeof toolId === 'string' && toolId.startsWith('app__')) {
      const appCallStartMs = Date.now();
      try {
        const { invokeAppTool } = await import('../../../agents/runtime/appAsToolGateway.js');
        // Propagate the calling node's model to the app so the operator's
        // model choice flows down. Without this every app silently runs on
        // whatever bedrock-nova-* it was configured with, regardless of
        // the agent's preferredModel.
        const callerModelId = context?.model?.id || context?.modelId || null;
        const result = await invokeAppTool({
          toolId,
          args,
          user,
          chatId,
          executionId: context.executionId,
          abortSignal: context.abortSignal,
          ...(callerModelId ? { modelOverride: callerModelId } : {})
        });
        const appCallDurationMs = Date.now() - appCallStartMs;
        // CRITICAL: previously the app__* branch returned BEFORE the step
        // log push below, so app invocations executed correctly but never
        // showed up in the transcript — operators saw "Apps available" but
        // empty Tool calls. Record the call here with the resolved app id,
        // args, response preview, and duration so the audit trail matches
        // what actually happened.
        const appId = toolId.slice('app__'.length);
        if (context._stepLog && Array.isArray(context._stepLog.toolCalls)) {
          context._stepLog.toolCalls.push({
            name: toolCall.function.name,
            toolId,
            appId,
            modelOverride: callerModelId,
            args: this._previewToolValue(args),
            result: this._previewToolValue(result),
            durationMs: appCallDurationMs
          });
        }
        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result)
        };
      } catch (error) {
        const appCallDurationMs = Date.now() - appCallStartMs;
        this.logger.error('App-as-tool invocation failed', {
          component: 'PromptNodeExecutor',
          toolId,
          error
        });
        if (context._stepLog && Array.isArray(context._stepLog.toolCalls)) {
          context._stepLog.toolCalls.push({
            name: toolCall.function.name,
            toolId,
            appId: toolId.slice('app__'.length),
            error: 'app_invocation_failed',
            message: error.message,
            args: this._previewToolValue(args),
            durationMs: appCallDurationMs
          });
        }
        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({ error: true, message: error.message })
        };
      }
    }

    try {
      // Make workflow state visible to agent tools that need to mutate it
      // (createTask / listTasks / markTaskDone / writeArtifact).
      const agentProfile = this._resolveAgentProfile(context);
      const enrichedAppConfig = {
        ...(appConfig || {}),
        ...(agentProfile ? { _agentProfile: agentProfile } : {}),
        ...(context._workflowState ? { _workflowState: context._workflowState } : {})
      };

      const toolCallStartMs = Date.now();
      const result = await runTool(toolId, {
        ...args,
        chatId,
        user,
        appConfig: enrichedAppConfig
      });
      const toolCallDurationMs = Date.now() - toolCallStartMs;

      // Auto-capture citations from search/extract tool results so the
      // synthesizer can cite each fact back to a URL. Without this, agents
      // produce free-form text that may or may not be grounded; with it
      // we get a per-run ledger of every URL the agent actually consulted.
      // Tag each citation with the current task id so per-task artifacts
      // can later filter their own Sources section.
      const captureTaskId = context._taskId || null;
      try {
        this._captureCitationsFromToolResult({
          toolId,
          args,
          result,
          state: context._workflowState,
          taskId: captureTaskId
        });
      } catch (captureErr) {
        // Citation capture must never fail a tool call.
        this.logger.warn('Citation capture failed', {
          component: 'PromptNodeExecutor',
          toolId,
          error: captureErr.message
        });
      }

      // Record on the step transcript so operators can audit every tool
      // call the agent made: name, args, a result preview, duration. App
      // invocations (synthetic `app__*` tools) carry their app id.
      if (context._stepLog && Array.isArray(context._stepLog.toolCalls)) {
        const isApp = typeof toolId === 'string' && toolId.startsWith('app__');
        context._stepLog.toolCalls.push({
          name: toolCall.function.name,
          toolId,
          ...(isApp ? { appId: toolId.slice('app__'.length) } : {}),
          args: this._previewToolValue(args),
          result: this._previewToolValue(result),
          durationMs: toolCallDurationMs
        });
      }

      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      };
    } catch (error) {
      this.logger.error('Tool execution failed', {
        component: 'PromptNodeExecutor',
        toolId,
        error
      });

      if (context._stepLog && Array.isArray(context._stepLog.toolCalls)) {
        context._stepLog.toolCalls.push({
          name: toolCall.function.name,
          toolId,
          error: 'execution_failed',
          message: error.message
        });
      }

      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify({
          error: true,
          message: error.message
        })
      };
    }
  }

  /**
   * Resolve the AgentProfile for the current context, if the workflow is an
   * agent run. The principal carries `profileId`; we look it up via
   * configCache.
   *
   * @private
   * @returns {Object|null}
   */
  _resolveAgentProfile(context) {
    const user = context?.user;
    if (!user?.isAgent || !user?.profileId) {
      this.logger.info('Agent profile not resolved: not an agent run', {
        component: 'PromptNodeExecutor',
        userId: user?.id,
        isAgent: user?.isAgent,
        hasProfileId: !!user?.profileId,
        executionId: context?.executionId
      });
      return null;
    }
    try {
      const profiles = configCache.getAgentProfiles ? configCache.getAgentProfiles(true) : null;
      if (!profiles?.data) {
        this.logger.warn('Agent profile lookup returned no profiles from cache', {
          component: 'PromptNodeExecutor',
          profileId: user.profileId
        });
        return null;
      }
      const resolved = profiles.data.find(p => p.id === user.profileId) || null;
      if (!resolved) {
        this.logger.warn('Agent profile id not found in cache', {
          component: 'PromptNodeExecutor',
          profileId: user.profileId,
          availableProfiles: profiles.data.map(p => p.id)
        });
      }
      return resolved;
    } catch (err) {
      this.logger.warn('Failed to resolve agent profile', {
        component: 'PromptNodeExecutor',
        profileId: user.profileId,
        error: err.message
      });
      return null;
    }
  }

  /**
   * Build the agent-skills system-prompt block for this node.
   *
   * Renders two sub-blocks the LLM gets to read in the system message:
   *
   *   <available_skills> … </available_skills>   (metadata only)
   *   <active_skill name="…"> … </active_skill>   (full SKILL.md body, repeated)
   *
   * "Available" lists what this node CAN activate. The planner uses it to
   * decide WHAT to do; task executors use it to look up procedural detail
   * for HOW. "Active" carries skill bodies the planner pre-activated (via
   * `skills_used` in its plan JSON) or that earlier task workers loaded
   * via the `activate_skill` tool. Both blocks are scoped per-run via
   * `state.data._activatedSkills`.
   *
   * Synthesizer nodes (`_isSynthesizer: true`) skip the metadata block — the
   * synthesizer doesn't choose skills — but DO see active bodies so the
   * final composition can match a skill's prescribed output format.
   *
   * @private
   * @returns {Promise<string|null>}
   */
  async _buildSkillsBlock(profile, config, state) {
    const isSynthesizer = config?._isSynthesizer === true;
    const skillIds =
      (Array.isArray(config?.skills) && config.skills.length > 0
        ? config.skills
        : Array.isArray(profile?.skills) && profile.skills.length > 0
          ? profile.skills
          : null) || null;

    const activated =
      state?.data?._activatedSkills && typeof state.data._activatedSkills === 'object'
        ? state.data._activatedSkills
        : {};

    if (!skillIds && Object.keys(activated).length === 0) return null;

    const parts = [];

    // <available_skills>: only for non-synthesizer nodes that have a catalog.
    if (skillIds && !isSynthesizer) {
      try {
        const platform = configCache.getPlatform()?.data || {};
        // Profile is duck-typed against `getSkillsForApp`'s expected shape
        // (just needs `.skills` array). Permission filtering is by user.
        const filtered = await configCache.getSkillsForApp(
          { skills: skillIds },
          { id: profile?.id || 'agent', groups: profile?.serviceAccount?.groups || [] },
          platform
        );
        if (Array.isArray(filtered) && filtered.length > 0) {
          const entries = filtered
            .map(
              s =>
                `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description || ''}</description>\n  </skill>`
            )
            .join('\n');
          parts.push(
            `<available_skills>\n${entries}\n</available_skills>\n\nWhen a skill's description matches the current work, call activate_skill({skill_name: "..."}) to load its full instructions. The skill body will then guide HOW to perform the task.`
          );
        }
      } catch (err) {
        this.logger.warn('Failed to render available_skills block', {
          component: 'PromptNodeExecutor',
          error: err.message
        });
      }
    }

    // <active_skill>: include for every node when a skill is already
    // activated in this run. Persisted across nodes via state.data.
    const activeNames = Object.keys(activated);
    if (activeNames.length > 0) {
      const blocks = activeNames
        .map(name => {
          const entry = activated[name];
          const body = typeof entry === 'string' ? entry : entry?.body || '';
          if (!body) return '';
          return `<active_skill name="${name}">\n${body}\n</active_skill>`;
        })
        .filter(Boolean);
      if (blocks.length > 0) {
        parts.push(blocks.join('\n\n'));
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  /**
   * Parse structured output according to a JSON schema.
   *
   * @param {string} content - Raw LLM response content
   * @param {Object} schema - JSON schema for validation
   * @param {string} nodeId - Node ID for error reporting
   * @param {Object} [meta] - Diagnostic context from the LLM call
   * @param {string} [meta.modelId] - Model that produced the output
   * @param {string} [meta.finishReason] - LLM finish reason ('stop'|'length'|'tool_calls'|...)
   * @param {number} [meta.maxTokens] - Configured output token cap for this call
   * @returns {*} Parsed output
   * @private
   */
  parseStructuredOutput(content, schema, nodeId, meta = {}) {
    if (!content) {
      return null;
    }

    // Try to extract JSON from the response
    try {
      // Check if content is already JSON
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        return JSON.parse(content);
      }

      // Try to find JSON in markdown code blocks
      const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonBlockMatch) {
        return JSON.parse(jsonBlockMatch[1].trim());
      }

      // Try to find JSON anywhere in the content
      const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      // If no JSON found, return content as-is
      this.logger.warn('Could not parse structured output, returning raw content', {
        component: 'PromptNodeExecutor',
        nodeId,
        modelId: meta.modelId,
        finishReason: meta.finishReason,
        contentLength: content.length
      });
      return content;
    } catch (error) {
      // Distinguish a truncated response (model hit its output token cap
      // mid-JSON) from a malformed-but-complete response. Both yield JSON
      // parse errors, but the remedy is different:
      //   - 'length' finishReason or an "Unterminated string/value" error
      //     near the end of the buffer → output was cut off. Raise maxTokens,
      //     switch to a model with a larger output cap, or use a stricter
      //     structured-output mode (response_format: json_schema) so the
      //     model self-limits.
      //   - any other parse error → the model emitted malformed JSON
      //     despite finishing. Inspect the tail of the content.
      const errorMessage = error?.message || String(error);
      const truncationByFinishReason = meta.finishReason === 'length';
      const truncationByErrorShape = /^(Unterminated|Unexpected end of)/i.test(errorMessage);
      const isTruncated = truncationByFinishReason || truncationByErrorShape;
      const tail = content.length > 240 ? `…${content.slice(-240)}` : content;

      if (isTruncated) {
        this.logger.warn(
          'Structured output was truncated by the model — JSON is incomplete. ' +
            'Raise maxTokens, pick a model with a larger output cap, or use a stricter ' +
            'structured-output mode so the model self-limits the response.',
          {
            component: 'PromptNodeExecutor',
            nodeId,
            modelId: meta.modelId,
            finishReason: meta.finishReason,
            configuredMaxTokens: meta.maxTokens,
            contentLength: content.length,
            parseError: errorMessage,
            truncationSignal: truncationByFinishReason
              ? 'finish_reason=length'
              : 'unterminated-value-at-end',
            contentTail: tail
          }
        );
      } else {
        this.logger.warn('JSON parse error for structured output', {
          component: 'PromptNodeExecutor',
          nodeId,
          modelId: meta.modelId,
          finishReason: meta.finishReason,
          configuredMaxTokens: meta.maxTokens,
          contentLength: content.length,
          parseError: errorMessage,
          contentTail: tail
        });
      }
      return content;
    }
  }

  /**
   * Auto-persist behavior the runtime owns now that the LLM no longer has
   * lifecycle tools:
   *
   *   - Planner task nodes (`config._isPlannerTask: true`): the final
   *     assistant text becomes a per-task artifact + `state.data._taskResults`
   *     entry, and the matching task in `_taskQueue` is auto-marked done.
   *
   *   - Synthesizer nodes (`config._isSynthesizer: true`): the final
   *     assistant text is persisted as `profile.artifacts.primary` (default
   *     `report.md`). No LLM tool call is required.
   *
   * Failures here are logged but never fail the node — the LLM response
   * already exists, and a transient disk error shouldn't abort the run.
   *
   * @private
   */
  async _autoPersistResult({
    node,
    config,
    output,
    response,
    state,
    context,
    agentProfile,
    executeStartedAt,
    executeStartMs,
    stepLog,
    effectiveTaskId,
    effectiveTaskTitle,
    effectiveLogKey,
    isDynamicTaskIteration
  }) {
    // isDynamicTaskIteration: drain dequeued a task and the body node is
    // running for that task. Treat it as a planner-task for persistence
    // (per-task artifact + _taskResults + _taskTimings + _taskQueue
    // markDone) so dynamic tasks behave identically to materialized planner
    // tasks from the operator's perspective.
    const isPlannerTask = config?._isPlannerTask === true || isDynamicTaskIteration === true;
    const isSynthesizer = config?._isSynthesizer === true;
    // EVERY agent prompt — planner task, synthesizer, simple agent, inbox
    // worker — needs its step transcript persisted so the run detail page
    // can show what happened. Previously this method early-returned for
    // anything that wasn't a planner-task or synthesizer, which made
    // inbox-worker and simple-agent runs look like nothing happened in the
    // UI (the LLM call ran but its trace was discarded). The artifact +
    // task-result writes below remain gated on planner-task / synthesizer
    // because those are the only two roles that should produce artifacts.

    // Resolve a usable string from `output` — could be a string, object, or
    // null depending on outputSchema parsing. We need string content to
    // write to disk and to put into _taskResults.
    let textContent;
    if (typeof output === 'string') {
      textContent = output;
    } else if (typeof response?.content === 'string') {
      textContent = response.content;
    } else if (output != null && typeof output === 'object') {
      try {
        textContent = JSON.stringify(output, null, 2);
      } catch {
        textContent = String(output);
      }
    } else {
      textContent = '';
    }

    // Resolve the ROOT run id so child sub-workflow tasks write into the
    // same `agent-artifacts/<rootId>/` directory the parent's artifact
    // endpoint lists. The engine builds executor context without chatId,
    // and state.executionId is the CURRENT (child) id — so we walk the
    // parent chain via state.data._parentExecutionId. Top-level runs have
    // no parent and use their own executionId.
    const runId = await this._resolveRootRunId(state, context);
    const profileId = context?.user?.profileId || agentProfile?.id;
    const chatId = context?.chatId || runId;
    const stateUpdates = {};

    // Persist the step transcript on every prompt-style execution (task
    // worker, synthesizer, simple agent). This gives operators a complete
    // audit trail per step. Keyed by effectiveLogKey so drain-mode iterations
    // (which share node.id="task_runner") each get their own transcript
    // under the task's id, rather than overwriting each other.
    const logKey = effectiveLogKey || node.id;
    if (stepLog) {
      // Snapshot the plan as it stood at the END of this round so the audit
      // trail shows how the task list evolved (set_plan replaces open tasks
      // each call — without this, earlier plans vanish without a trace).
      if (Array.isArray(state?.data?._taskQueue)) {
        stepLog.planSnapshot = state.data._taskQueue.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status
        }));
      }
      // Preserve EVERY iteration's transcript, not just the last (cyclic
      // agent↔verify loop reuses node.id="agent" across rounds).
      Object.assign(
        stateUpdates,
        this.buildStepLogUpdates(state, logKey, stepLog, context?.iteration ?? null)
      );
    }

    // Concurrency safety: re-publish state slots that tools may have
    // mutated in-place during the LLM iteration loop. Fire-and-forget
    // updaters (e.g. titleGenerator) can replace activeStates.entry.data
    // mid-execution; the executor still holds a reference to the OLD data
    // object and its tool mutations end up orphaned. Including these
    // slots in stateUpdates lets the engine's deepMerge resync them into
    // the live entry — even if the entry was replaced under us.
    if (Array.isArray(state?.data?._taskQueue)) {
      stateUpdates._taskQueue = state.data._taskQueue;
    }
    if (Array.isArray(state?.data?._citations)) {
      stateUpdates._citations = state.data._citations;
    }
    if (state?.data?._activatedSkills && typeof state.data._activatedSkills === 'object') {
      stateUpdates._activatedSkills = state.data._activatedSkills;
    }
    if (state?.data?._agent && typeof state.data._agent === 'object') {
      stateUpdates._agent = state.data._agent;
    }

    // Generic timing entry for the step timeline. Planner tasks and
    // synthesizer have their own (richer) _taskTimings updates further
    // below; this is the fallback path for simple-agent / inbox-worker /
    // any other prompt node so they don't appear timing-less in the UI.
    if (!isPlannerTask && !isSynthesizer) {
      const completedAtMs = Date.now();
      const startedAtIso = executeStartedAt ? executeStartedAt.toISOString() : null;
      const durationMs = executeStartMs ? completedAtMs - executeStartMs : null;
      stateUpdates._taskTimings = {
        ...(state?.data?._taskTimings || {}),
        [logKey]: {
          startedAt: startedAtIso || new Date(completedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs
        }
      };
    }

    if (isPlannerTask) {
      // Prefer effectiveTaskId/Title — they fold in the per-iteration task
      // from drain mode (_currentTask) when the body node config doesn't
      // carry _taskId statically. For materialized planner-task nodes from
      // SubWorkflowMaterializer, these match config._taskId / _taskTitle.
      const taskId = effectiveTaskId || config?._taskId || node.id;
      const taskTitle = effectiveTaskTitle || config?._taskTitle || node.name || node.id;
      const completedAt = new Date().toISOString();

      // Pull out the citations captured DURING this task. We tagged each
      // citation with `taskId` in _captureCitationsFromToolResult and
      // _captureCitationsFromGroundingMetadata. Filtering here gives every
      // sub-task artifact its own focused Sources section instead of
      // relying on the run-global ledger.
      const allCitations = Array.isArray(state?.data?._citations) ? state.data._citations : [];
      const taskCitations = allCitations.filter(c => c && c.taskId === taskId);

      const completedAtMs = Date.now();
      const startedAtIso = executeStartedAt ? executeStartedAt.toISOString() : null;
      const durationMs = executeStartMs ? completedAtMs - executeStartMs : null;

      const taskResults = { ...(state?.data?._taskResults || {}) };
      taskResults[taskId] = {
        taskId,
        nodeId: node.id,
        title: taskTitle,
        content: textContent,
        citations: taskCitations.map(c => ({ url: c.url, title: c.title })),
        // Prefer the model the provider echoes back; fall back to the model we
        // RESOLVED for this step (stepLog.model). vLLM/Gemini often omit `model`
        // in their streaming responses, which left _taskResults[*].model null so
        // the UI couldn't show which model ran each planner sub-task.
        model: response?.model || stepLog?.model || null,
        startedAt: startedAtIso || completedAt,
        completedAt,
        durationMs
      };
      stateUpdates._taskResults = taskResults;
      // Side-channel: store latest task timing in _taskTimings keyed by id
      // so the UI doesn't have to scan _taskResults (which can grow large
      // with full content per task) just to render durations.
      const taskTimings = { ...(state?.data?._taskTimings || {}) };
      taskTimings[taskId] = {
        startedAt: startedAtIso || completedAt,
        completedAt,
        durationMs
      };
      stateUpdates._taskTimings = taskTimings;

      // Auto-mark the task in _taskQueue if present (planner tasks materialized
      // into _taskQueue carry the same id; ones that don't will just no-op).
      if (Array.isArray(state?.data?._taskQueue)) {
        const queue = state.data._taskQueue.map(t =>
          t && t.id === taskId
            ? { ...t, status: 'done', result: textContent, updatedAt: completedAt }
            : t
        );
        stateUpdates._taskQueue = queue;
      }

      // Write per-task artifact (best-effort).
      if (runId) {
        try {
          const safeTaskSlug = String(taskId)
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .slice(0, 80);
          await writeArtifactDirect({
            runId,
            name: `task_${safeTaskSlug}.md`,
            content: this._formatTaskArtifact({
              title: taskTitle,
              content: textContent,
              citations: taskCitations
            }),
            contentType: 'text/markdown',
            profileId,
            chatId,
            state
          });
        } catch (err) {
          this.logger.warn('Auto-persist of planner task artifact failed', {
            component: 'PromptNodeExecutor',
            nodeId: node.id,
            taskId,
            error: err.message
          });
        }
      }

      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.task.completed',
          chatId,
          profileId,
          taskId,
          nodeId: node.id,
          title: taskTitle,
          // Carry the timing so the UI step-timeline updates live —
          // without this the timing only appears after a state refetch.
          startedAt: startedAtIso || completedAt,
          completedAt,
          durationMs
        });
      } catch {
        // Best effort.
      }

      // Incrementally publish this task's result + timing to the PARENT
      // (root) execution's state. Without this, _taskResults only lands in
      // the parent at the end-of-sub-workflow bubble-up — so if the parent
      // planner node times out (or crashes) before that point, the UI on
      // reload sees an empty _taskResults and renders the task as "open"
      // even though its artifact is on disk. By writing per-task into the
      // parent state here, every completed task survives a reload independent
      // of whether bubble-up ever runs.
      try {
        const parentId = await this._resolveRootRunId(state, context);
        if (parentId && parentId !== state.executionId) {
          const { getStateManager } = await import('../StateManager.js');
          const stateManager = getStateManager();
          await stateManager.update(parentId, {
            data: {
              _taskResults: { [taskId]: taskResults[taskId] },
              _taskTimings: { [taskId]: taskTimings[taskId] }
            }
          });
          // Flush the parent's state to disk so the run survives a server
          // restart mid-sub-workflow. Without this, the parent's planner node
          // blocks for the whole sub-workflow duration and the engine only
          // checkpoints when the planner returns — so a restart during a
          // long research run loses everything except the per-task artifacts
          // that writeArtifactDirect already saved.
          try {
            await stateManager.checkpoint(parentId, `after_task_${taskId}`);
          } catch (checkpointErr) {
            this.logger.warn('Per-task checkpoint of parent state failed', {
              component: 'PromptNodeExecutor',
              parentId,
              taskId,
              error: checkpointErr.message
            });
          }
        }
      } catch (persistErr) {
        this.logger.warn('Incremental task-result publish to parent failed', {
          component: 'PromptNodeExecutor',
          nodeId: node.id,
          taskId,
          error: persistErr.message
        });
      }
    }

    if (isSynthesizer) {
      // Stash the synthesizer text as a state variable for downstream nodes
      // (e.g. inbox-finalize uses it for the completion note). The
      // synthesizer is plain-text now — memory writing is a separate
      // explicit step (`memory-compose` → `memory-finalize`).
      stateUpdates._synthesizerOutput = textContent;
      stateUpdates._synthesizerSummary = textContent.slice(0, 240);
      // Record synthesizer timing in the same _taskTimings map keyed by
      // node id so the step timeline can display it like any other step.
      const synthCompletedMs = Date.now();
      const synthStartedAtIso = executeStartedAt ? executeStartedAt.toISOString() : null;
      const synthDurationMs = executeStartMs ? synthCompletedMs - executeStartMs : null;
      stateUpdates._taskTimings = {
        ...(state?.data?._taskTimings || {}),
        [node.id]: {
          startedAt: synthStartedAtIso || new Date(synthCompletedMs).toISOString(),
          completedAt: new Date(synthCompletedMs).toISOString(),
          durationMs: synthDurationMs
        }
      };
      try {
        actionTracker.emit('fire-sse', {
          event: 'agent.step.completed',
          chatId,
          nodeId: node.id,
          kind: 'synthesizer',
          startedAt: synthStartedAtIso,
          completedAt: new Date(synthCompletedMs).toISOString(),
          durationMs: synthDurationMs
        });
      } catch {
        // best effort
      }

      // Persist as the profile's primary artifact (default report.md).
      const primaryName =
        (agentProfile?.artifacts && typeof agentProfile.artifacts.primary === 'string'
          ? agentProfile.artifacts.primary
          : null) || 'report.md';

      if (runId) {
        try {
          await writeArtifactDirect({
            runId,
            name: primaryName,
            content: textContent,
            contentType: 'text/markdown',
            profileId,
            chatId,
            state
          });
        } catch (err) {
          this.logger.error('Auto-persist of synthesizer artifact failed', {
            component: 'PromptNodeExecutor',
            nodeId: node.id,
            primaryName,
            error: err.message
          });
        }
      }
    }

    // Memory composer branch — the explicit LLM step that decides what (if
    // anything) from this run is worth committing to long-term memory.
    // Pushes a normalized entry onto state.data._pendingMemoryUpdates which
    // the deterministic memory-finalize node drains on the next hop. A
    // skip=true response (or empty content) is a no-op.
    if (config?._isMemoryComposer === true) {
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const skip = output.skip === true;
        const content = typeof output.content === 'string' ? output.content.trim() : '';
        if (!skip && content.length > 0) {
          const entry = {
            mode: output.mode === 'replace' ? 'replace' : 'append',
            content,
            ...(typeof output.summary === 'string' && output.summary.trim().length > 0
              ? { summary: output.summary.trim() }
              : {})
          };
          const prior = Array.isArray(state?.data?._pendingMemoryUpdates)
            ? state.data._pendingMemoryUpdates
            : [];
          stateUpdates._pendingMemoryUpdates = [...prior, entry];
          this.logger.info('Memory composer produced a delta', {
            component: 'PromptNodeExecutor',
            nodeId: node.id,
            mode: entry.mode,
            contentLength: entry.content.length,
            hasSummary: !!entry.summary
          });
        } else {
          this.logger.info('Memory composer chose to skip (nothing worth remembering)', {
            component: 'PromptNodeExecutor',
            nodeId: node.id,
            skipFlag: skip,
            hadContent: content.length > 0
          });
        }
      }
    }

    // Reviewer branch — bump the review round counter and stash gaps so the
    // next planner iteration can read them. Loop entry/exit is driven by
    // LoopNodeExecutor.while reading state.data._reviewRound and
    // _reviewOutput, both of which we set here.
    //
    // Parse-failure handling: when the reviewer LLM returns a non-object
    // output (Gemini schema mismatch, truncated JSON, etc.) the auto-persist
    // path lands here with `output` as null / a string. We MUST still bump
    // _reviewRound — otherwise the loop would re-enter forever — but we
    // also synthesize an explicit `_reviewOutput = { needs_more_work: false,
    // _parseError: true, ... }` so:
    //   (a) the while-loop condition sees a falsy needs_more_work and exits,
    //   (b) the operator can SEE the parse failure on the run timeline
    //       instead of just observing an unexplained early exit.
    if (config?._isReviewer === true) {
      const priorRound =
        typeof state?.data?._reviewRound === 'number' ? state.data._reviewRound : 0;
      const isValidObject = output && typeof output === 'object' && !Array.isArray(output);
      stateUpdates._reviewRound = priorRound + 1;
      if (isValidObject) {
        stateUpdates._lastReviewGaps = Array.isArray(output.gaps) ? output.gaps : [];
      } else {
        // Surface the failure on state so downstream nodes / UI know why
        // the loop didn't continue. outputVariable=_reviewOutput already
        // landed `null` (or the malformed string) — replace it with a
        // well-formed sentinel object so consumers don't have to special-
        // case typeof checks.
        stateUpdates._lastReviewGaps = [];
        stateUpdates._reviewOutput = {
          needs_more_work: false,
          rationale:
            'Reviewer returned malformed output (not a structured object). ' +
            'Treating as "no more work needed" to allow the run to finish; ' +
            'see step log for the raw response.',
          gaps: [],
          _parseError: true
        };
        this.logger.warn('Reviewer output was not a structured object — exiting loop cleanly', {
          component: 'PromptNodeExecutor',
          nodeId: node.id,
          round: priorRound + 1,
          outputType: typeof output,
          outputPreview: this._previewToolValue(output)
        });
      }
      this.logger.info('Review round completed', {
        component: 'PromptNodeExecutor',
        nodeId: node.id,
        round: priorRound + 1,
        parseError: !isValidObject,
        needsMoreWork: isValidObject && output?.needs_more_work === true,
        gapCount: isValidObject && Array.isArray(output?.gaps) ? output.gaps.length : 0
      });
    }

    // Primary-producer prompts (simple agent, inbox-worker WITHOUT a
    // synthesizer): the runtime persists their output as the run's primary
    // artifact and stashes the text in _synthesizerOutput so inbox-finalize
    // can use it as the completion note — same downstream behavior as the
    // synthesizer path, but emitted from the agent node itself. Skipped
    // when a real synthesizer ran (it already wrote the artifact).
    if (config?._persistAsArtifact === true && !isPlannerTask && !isSynthesizer) {
      stateUpdates._synthesizerOutput = textContent;
      stateUpdates._synthesizerSummary = textContent.slice(0, 240);
      const primaryName =
        (agentProfile?.artifacts && typeof agentProfile.artifacts.primary === 'string'
          ? agentProfile.artifacts.primary
          : null) || 'report.md';
      // The agent node re-runs on each adversarial-review revision and persists
      // per step. Overwriting would lose the earlier drafts (the run's
      // history); writing the same name repeatedly piles up indistinguishable
      // copies. Version every attempt after the first: report.md, report.v2.md,
      // report.v3.md — so each revision is preserved and legible.
      const priorVersions = state?.data?._artifactVersions || {};
      const priorCount = priorVersions[primaryName] || 0;
      const dot = primaryName.lastIndexOf('.');
      const versionedName =
        priorCount === 0
          ? primaryName
          : dot > 0
            ? `${primaryName.slice(0, dot)}.v${priorCount + 1}${primaryName.slice(dot)}`
            : `${primaryName}.v${priorCount + 1}`;
      stateUpdates._artifactVersions = { ...priorVersions, [primaryName]: priorCount + 1 };
      if (runId && textContent) {
        try {
          await writeArtifactDirect({
            runId,
            name: versionedName,
            content: textContent,
            contentType: 'text/markdown',
            profileId,
            chatId,
            state
          });
        } catch (err) {
          this.logger.error('Auto-persist of primary-producer artifact failed', {
            component: 'PromptNodeExecutor',
            nodeId: node.id,
            primaryName,
            error: err.message
          });
        }
      }
    }

    return { stateUpdates };
  }

  /**
   * Build a compact preview of a tool-call value (args or result) for the
   * step transcript. Caps strings at 1 KB and JSON-stringifies objects
   * with the same cap so a noisy webSearch result doesn't blow up state
   * size. The original full result is still passed back to the LLM —
   * this is purely for the audit log.
   *
   * @private
   */
  /**
   * Walk a string and return the substring covering the first balanced
   * top-level JSON object (or array). Returns null if no balanced object
   * can be found. Used to recover from providers that emit concatenated
   * tool-args fragments like `{"a":1}{"b":2}` after streaming.
   *
   * Tracks brace depth, skips characters inside strings, and respects
   * backslash escapes inside strings. No JSON-correctness validation — the
   * caller still has to JSON.parse the returned prefix.
   * @private
   */
  _extractFirstJsonObject(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trimStart();
    const startOffset = raw.length - trimmed.length;
    if (trimmed.length === 0) return null;
    const opener = trimmed[0];
    if (opener !== '{' && opener !== '[') return null;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          return raw.slice(startOffset, startOffset + i + 1);
        }
      }
    }
    return null;
  }

  _previewToolValue(value) {
    const MAX_LEN = 1024;
    const MAX_FIELD_LEN = 320;
    if (value == null) return null;
    if (typeof value === 'string') {
      return value.length > MAX_LEN
        ? `${value.slice(0, MAX_LEN)}…[truncated ${value.length - MAX_LEN} chars]`
        : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    // For objects/arrays we walk the structure and shorten long string fields
    // IN PLACE, then JSON.stringify. The resulting preview stays parseable
    // (the UI does JSON.parse on reviewer / memory-compose step output to
    // render verdict details — a "…[truncated]" suffix appended to the JSON
    // string itself broke that and showed a generic fallback).
    try {
      const compact = this._compactStringsForPreview(value, MAX_FIELD_LEN, 0);
      const json = JSON.stringify(compact);
      // Final safety net: if the compacted form is still huge, fall back to
      // truncating the JSON string (and accept that the UI's JSON.parse will
      // fail for this row — better than spilling MB of state to disk).
      return json.length > MAX_LEN
        ? `${json.slice(0, MAX_LEN)}…[truncated ${json.length - MAX_LEN} chars]`
        : json;
    } catch {
      return '[unserialisable]';
    }
  }

  /**
   * Recursively shorten long string fields inside an object/array so the
   * JSON.stringify output stays under ~1KB while remaining VALID JSON.
   * String fields longer than `maxFieldLen` get a `…[+N]` suffix appended
   * in the cloned copy. Depth is bounded to keep cyclic / pathological
   * inputs from blowing the stack; arrays are capped at MAX_ARRAY_ITEMS
   * with a trailing `…[+N items]` placeholder.
   *
   * Used by `_previewToolValue` so step-log previews of tool args/results
   * AND structured-output rows (reviewer, memory-composer) all produce
   * JSON the UI can `JSON.parse` to render details.
   *
   * @private
   */
  _compactStringsForPreview(value, maxFieldLen, depth) {
    const MAX_DEPTH = 6;
    const MAX_ARRAY_ITEMS = 20;
    if (depth > MAX_DEPTH) return '[…]';
    if (typeof value === 'string') {
      return value.length > maxFieldLen
        ? `${value.slice(0, maxFieldLen)}…[+${value.length - maxFieldLen}]`
        : value;
    }
    if (Array.isArray(value)) {
      const limited = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map(v => this._compactStringsForPreview(v, maxFieldLen, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) {
        limited.push(`…[+${value.length - MAX_ARRAY_ITEMS} items]`);
      }
      return limited;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this._compactStringsForPreview(v, maxFieldLen, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * Format the per-task result body so it reads well both as a standalone
   * file and as a contribution to `{{previousTaskResults}}` in the
   * synthesizer prompt. When per-task citations were captured (web search
   * / extract / grounding URLs the task consulted), append a Sources
   * section so each subtask artifact stands on its own — operators can
   * audit each task in isolation without cross-referencing the run-wide
   * ledger.
   *
   * @private
   */
  _formatTaskArtifact({ title, content, citations }) {
    const safeTitle = (title || 'Task').toString().trim();
    let body = `# ${safeTitle}\n\n${content || ''}`.trim();
    if (Array.isArray(citations) && citations.length > 0) {
      const seen = new Set();
      const lines = [];
      for (const c of citations) {
        if (!c || typeof c.url !== 'string' || seen.has(c.url)) continue;
        seen.add(c.url);
        const label = c.title ? `[${c.title}](${c.url})` : c.url;
        lines.push(`- ${label}`);
      }
      if (lines.length > 0) {
        body += `\n\n## Sources\n\n${lines.join('\n')}`;
      }
    }
    return body + '\n';
  }

  /**
   * Extract URLs / titles / snippets from a search-or-extract tool result
   * and append them to `state.data._citations`. The synthesizer reads this
   * ledger to ground every fact with a citation.
   *
   * Naming note: `_citations` is the runtime ledger of URLs the agent
   * actually consulted during this run. It is NOT the same as
   * `profile.sources` (configured knowledge bases the agent can look up).
   * Separating the names prevents the synthesizer from confusing
   * "knowledge bases I could query" with "documents I cited".
   *
   * Recognised tool result shapes:
   *   - Array of `{ url, title?, snippet? }` (typical webSearch)
   *   - `{ results: [{ url, ... }, ...] }` (search wrappers)
   *   - `{ url, content, ... }` (webContentExtractor and similar)
   *   - `{ items: [...] }` / `{ sources: [...] }` (other variants)
   *
   * Tools whose IDs match the citation-producing allowlist below are
   * scanned. Other tools (createTask, write_memory, …) are ignored.
   *
   * @private
   */
  _captureCitationsFromToolResult({ toolId, args, result, state, taskId }) {
    if (!state || !state.data) return;
    if (!this._isCitationProducingTool(toolId)) return;

    const newEntries = [];
    const seen = new Set((state.data._citations || []).map(s => s.url).filter(Boolean));
    const push = entry => {
      if (!entry || !entry.url || typeof entry.url !== 'string') return;
      if (seen.has(entry.url)) return;
      seen.add(entry.url);
      newEntries.push(entry);
    };

    const harvest = items => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const url = item.url || item.link || item.source || item.href;
        if (!url || typeof url !== 'string') continue;
        push({
          url,
          title: item.title || item.name || item.heading || undefined,
          snippet:
            typeof item.snippet === 'string'
              ? item.snippet.slice(0, 400)
              : typeof item.summary === 'string'
                ? item.summary.slice(0, 400)
                : typeof item.text === 'string'
                  ? item.text.slice(0, 400)
                  : undefined,
          toolId,
          taskId: taskId || undefined,
          query: typeof args?.query === 'string' ? args.query : undefined,
          capturedAt: new Date().toISOString()
        });
      }
    };

    if (Array.isArray(result)) {
      harvest(result);
    } else if (result && typeof result === 'object') {
      if (Array.isArray(result.results)) harvest(result.results);
      if (Array.isArray(result.items)) harvest(result.items);
      if (Array.isArray(result.sources)) harvest(result.sources);
      // Single-doc results like webContentExtractor: { url, content, ... }
      if (typeof result.url === 'string') {
        push({
          url: result.url,
          title: result.title || result.name || undefined,
          snippet:
            typeof result.content === 'string'
              ? result.content.slice(0, 400)
              : typeof result.snippet === 'string'
                ? result.snippet.slice(0, 400)
                : undefined,
          toolId,
          taskId: taskId || undefined,
          query: typeof args?.url === 'string' ? args.url : undefined,
          capturedAt: new Date().toISOString()
        });
      }
    }

    if (newEntries.length > 0) {
      state.data._citations = [...(state.data._citations || []), ...newEntries];
    }
  }

  /**
   * Extract citation URLs from a Gemini grounding metadata block and
   * append them to `state.data._citations`. Gemini's native googleSearch
   * grounding produces a `groundingMetadata.groundingChunks[]` array
   * where each entry has shape `{ web: { uri, title } }`. Optionally a
   * `webSearchQueries: [string]` array carries the queries that produced
   * the chunks — we use the first query as the captured `query` field.
   *
   * Without this, agents whose webSearch was auto-swapped to googleSearch
   * (every Gemini run with webSearch configured) collect zero citations
   * and the synthesizer's References section comes out empty.
   *
   * @private
   */
  async _captureCitationsFromGroundingMetadata({ groundingMetadata, state, taskId }) {
    if (!state || !state.data) return;
    if (!groundingMetadata || typeof groundingMetadata !== 'object') return;

    const chunks = Array.isArray(groundingMetadata.groundingChunks)
      ? groundingMetadata.groundingChunks
      : [];
    if (chunks.length === 0) return;

    const queries = Array.isArray(groundingMetadata.webSearchQueries)
      ? groundingMetadata.webSearchQueries
      : [];
    const queryStr = queries.length > 0 ? queries.join(' | ') : undefined;

    // Resolve Gemini's vertexaisearch grounding-redirect URLs to their
    // canonical destinations before storing. Feeding the raw redirect
    // URLs back into a follow-up Gemini call triggers 400 INVALID_ARGUMENT
    // (the model refuses input containing its own grounding-redirect
    // tokens). Resolving here means every downstream consumer — the
    // synthesizer's citations ledger, the UI, logs — gets a clean URL.
    const rawUrls = [];
    for (const chunk of chunks) {
      const web = chunk?.web || chunk?.retrievedContext?.web;
      const url = web?.uri || web?.url;
      if (typeof url === 'string' && url) rawUrls.push(url);
    }
    const resolvedMap = await this._resolveGroundingRedirects(rawUrls);

    const seen = new Set((state.data._citations || []).map(c => c.url).filter(Boolean));
    const newEntries = [];
    for (const chunk of chunks) {
      const web = chunk?.web || chunk?.retrievedContext?.web;
      const rawUrl = web?.uri || web?.url;
      if (typeof rawUrl !== 'string' || !rawUrl) continue;
      const url = resolvedMap.get(rawUrl) || rawUrl;
      if (seen.has(url)) continue;
      seen.add(url);
      newEntries.push({
        url,
        title: typeof web?.title === 'string' ? web.title : undefined,
        toolId: 'googleSearch',
        taskId: taskId || undefined,
        query: queryStr,
        capturedAt: new Date().toISOString()
      });
    }
    if (newEntries.length > 0) {
      state.data._citations = [...(state.data._citations || []), ...newEntries];
    }
  }

  /**
   * Resolve Gemini's `vertexaisearch.cloud.google.com/grounding-api-redirect/<token>`
   * URLs to their canonical destinations via a HEAD request that does not
   * auto-follow. Non-grounding URLs pass through unchanged. Failures fall
   * back to a token-stripped placeholder so the original redirect token
   * never reaches a follow-up Gemini call (which rejects it with 400).
   *
   * Results are memoized on the executor instance because the same
   * citation often appears across multiple tasks in one workflow run.
   *
   * @private
   * @param {string[]} urls
   * @returns {Promise<Map<string,string>>}
   */
  async _resolveGroundingRedirects(urls) {
    const REDIRECT_PREFIX = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';
    const out = new Map();
    if (!this._groundingResolveCache) this._groundingResolveCache = new Map();
    const cache = this._groundingResolveCache;

    const toFetch = [];
    for (const url of urls) {
      if (out.has(url)) continue;
      if (!url.startsWith(REDIRECT_PREFIX)) {
        out.set(url, url);
        continue;
      }
      if (cache.has(url)) {
        out.set(url, cache.get(url));
        continue;
      }
      toFetch.push(url);
    }

    if (toFetch.length === 0) return out;

    await Promise.all(
      toFetch.map(async url => {
        let resolved;
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 5000);
          const resp = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            signal: ac.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 iHub-Apps' }
          });
          clearTimeout(timer);
          const location = resp.headers.get('location');
          if (location && !location.startsWith(REDIRECT_PREFIX)) {
            resolved = location;
          }
        } catch (err) {
          this.logger.debug?.('Grounding redirect resolution failed', {
            component: 'PromptNodeExecutor',
            error: err.message
          });
        }
        // Fallback: strip the long opaque token so the URL no longer
        // trips Gemini's input filter. We still keep the host so the
        // citation is recognizable as a Google grounding result.
        if (!resolved) {
          resolved = `${REDIRECT_PREFIX}unresolved`;
        }
        cache.set(url, resolved);
        out.set(url, resolved);
      })
    );

    return out;
  }

  /**
   * Heuristic for whether a tool call produces citable URLs. Used by
   * citation capture to skip irrelevant tool calls (memory writes, task
   * creation, etc.) so the ledger stays clean.
   *
   * Both web tools (webSearch, webContentExtractor) and configured
   * knowledge-base lookups (`source_*`) qualify — when an agent consults
   * one of its configured sources, the document URL becomes a citation
   * just like a web search result.
   *
   * @private
   */
  _isCitationProducingTool(toolId) {
    if (typeof toolId !== 'string') return false;
    const id = toolId.toLowerCase();
    // Any *search* tool (webSearch, braveSearch, tavilySearch, …) plus the
    // content extractor and configured source_ lookups. Previously this only
    // matched the literal `websearch`, so the configured `braveSearch` tool
    // produced ZERO citations — its result URLs were silently dropped. The
    // harvest below guards on a url field, so a non-search tool that happens to
    // match contributes nothing anyway.
    if (id.includes('search') || id === 'webcontentextractor') return true;
    if (id.startsWith('source_')) return true;
    // Provider-native grounding (googleSearch) doesn't appear in the tool
    // call loop — Gemini emits it as grounding metadata in the assistant
    // message — so we don't try to capture from a tool result here.
    return false;
  }

  /**
   * Render `state.data._taskResults` (a keyed map of per-task completion
   * records) as a markdown block suitable for substituting into
   * `{{previousTaskResults}}` in subsequent task prompts and the
   * synthesizer prompt.
   *
   * Records are emitted in completion order so the synthesizer sees the
   * planner's chosen sequence intact.
   *
   * @private
   */
  _formatPreviousTaskResults(state) {
    const map = state?.data?._taskResults;
    if (!map || typeof map !== 'object') return '';
    const entries = Object.values(map)
      .filter(r => r && typeof r === 'object')
      .sort((a, b) => {
        const ta = a.completedAt || '';
        const tb = b.completedAt || '';
        if (ta === tb) return 0;
        return ta < tb ? -1 : 1;
      });
    if (entries.length === 0) return '';
    return entries
      .map(r => {
        const title = (r.title || r.taskId || 'Task').toString().trim();
        const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content || '');
        return `### ${title}\n\n${body}`.trim();
      })
      .join('\n\n---\n\n');
  }

  /**
   * Walk the sub-workflow parent chain to find the topmost run id. Used as
   * the artifact directory key so files written from inside a planner
   * sub-workflow co-locate with the user-facing run's artifacts.
   *
   * Each sub-workflow records its immediate parent at
   * `state.data._parentExecutionId` (set by WorkflowEngine.executeSubWorkflow).
   * Walking up that chain gives the root. We cap the walk at 5 hops so a
   * cycle in the data can never lock the executor.
   *
   * @private
   */
  async _resolveRootRunId(state, context) {
    let executionId = state?.executionId || context?.executionId;
    let parentId = state?.data?._parentExecutionId;
    if (!parentId) return executionId || context?.chatId || null;

    try {
      const { getStateManager } = await import('../StateManager.js');
      const stateManager = getStateManager();
      let hops = 0;
      while (parentId && hops < 5) {
        const parentState = await stateManager.get(parentId);
        if (!parentState) break;
        executionId = parentState.executionId || parentId;
        parentId = parentState.data?._parentExecutionId;
        hops++;
      }
    } catch (err) {
      this.logger.warn('Failed to walk parent chain for artifact root', {
        component: 'PromptNodeExecutor',
        error: err.message
      });
    }
    return executionId || context?.chatId || null;
  }

  /**
   * Render `state.data._citations` as a numbered list the synthesizer can
   * cite with `[N]`. Dedupe by URL while preserving insertion order —
   * first occurrence wins so `[1]` is the earliest citation the agent
   * collected during this run.
   *
   * @private
   */
  _formatCitations(state) {
    const citations = state?.data?._citations;
    if (!Array.isArray(citations) || citations.length === 0) return '';
    const seen = new Set();
    const ordered = [];
    for (const c of citations) {
      if (!c || typeof c !== 'object' || typeof c.url !== 'string') continue;
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      ordered.push(c);
    }
    if (ordered.length === 0) return '';
    return ordered
      .map((c, i) => {
        const label = c.title ? `${c.title} — ${c.url}` : c.url;
        const tail = c.snippet
          ? `\n    ${String(c.snippet).replace(/\s+/g, ' ').slice(0, 240)}`
          : '';
        return `[${i + 1}] ${label}${tail}`;
      })
      .join('\n');
  }
}

export default PromptNodeExecutor;
