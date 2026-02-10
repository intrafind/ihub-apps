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
 * @module services/workflow/executors/AgentNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import ChatService from '../../chat/ChatService.js';
import { normalizeToolName } from '../../../adapters/toolCalling/index.js';
import { getToolsForApp, runTool } from '../../../toolLoader.js';
import configCache from '../../../configCache.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import { estimateTokens } from '../../../usageTracker.js';

/**
 * Agent node configuration
 * @typedef {Object} AgentNodeConfig
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
 * // Agent node configuration
 * {
 *   id: 'research-agent',
 *   type: 'agent',
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
export class AgentNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new AgentNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
    this.chatService = options.chatService || new ChatService();
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
    this.maxIterations = options.maxIterations || 10;
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

    this.logger.info({
      component: 'AgentNodeExecutor',
      message: `Executing agent node '${node.id}'`,
      nodeId: node.id,
      hasTools: (config.tools || []).length > 0
    });

    try {
      // Build messages from config and state
      const messages = this.buildMessages(config, state, context);

      // Get model configuration (pass state for model override support)
      const model = await this.getModel(config.modelId, context, state);
      if (!model) {
        return this.createErrorResult(`Model not found: ${config.modelId || 'default'}`, {
          nodeId: node.id
        });
      }

      // Get tools if configured
      let tools = [];
      if (config.tools && config.tools.length > 0) {
        tools = await this.getAgentTools(config.tools, language, context);
      }

      // Execute LLM call (with tool loop if tools are available)
      const response = await this.executeLLMWithTools({
        model,
        messages,
        tools,
        config,
        context,
        nodeId: node.id
      });

      // Parse output according to schema if defined
      let output = response.content;
      if (config.outputSchema) {
        output = this.parseStructuredOutput(response.content, config.outputSchema, node.id);
      }

      this.logger.info({
        component: 'AgentNodeExecutor',
        message: `Agent node '${node.id}' completed`,
        nodeId: node.id,
        hasOutput: output !== undefined,
        model: model.id
      });

      // Build state updates
      const stateUpdates = config.outputVariable ? { [config.outputVariable]: output } : undefined;

      // Build result with model info and token usage for UI display
      const result = this.createSuccessResult(
        {
          content: output,
          model: model.id,
          modelName: model.name,
          iterations: response.iterations,
          tokens: response.tokens
        },
        { stateUpdates }
      );

      // Include tokens at result level for metrics aggregation
      result.tokens = response.tokens;

      // Add outputVariable to result for UI display
      if (config.outputVariable) {
        result.outputVariable = config.outputVariable;
        result.output = output; // Store the actual output value directly
      }

      return result;
    } catch (error) {
      this.logger.error({
        component: 'AgentNodeExecutor',
        message: `Agent node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
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
   * @param {Object} config - Agent configuration
   * @param {Object} state - Workflow state
   * @param {Object} context - Execution context
   * @returns {Array<Object>} Array of message objects
   * @private
   */
  buildMessages(config, state, context) {
    const messages = [];
    const language = context?.language || 'en';

    // Add system message if configured
    if (config.system) {
      const systemTemplate = this.getLocalizedValue(config.system, language);
      const systemContent = this.resolveTemplateVariables(systemTemplate, state);
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
            this.logger.warn({
              component: 'AgentNodeExecutor',
              message: `Unknown comparison operator: ${operator}`
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
        this.logger.warn({
          component: 'AgentNodeExecutor',
          message: `Unbalanced {{#each}} block for path: ${arrayPath}`
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
   * 3. Model from execution context
   * 4. Default model
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

    // 1. Use model from node config if specified
    if (modelId) {
      return models.find(m => m.id === modelId);
    }

    // 2. Check for model override from initial data (user selection at start)
    const modelOverride = state?.data?._modelOverride;
    if (modelOverride) {
      const overrideModel = models.find(m => m.id === modelOverride);
      if (overrideModel) {
        return overrideModel;
      }
    }

    // 3. Use context model if available
    if (context.modelId) {
      return models.find(m => m.id === context.modelId);
    }

    // 4. Fall back to default model
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
    const maxIterations = config.maxIterations || this.maxIterations;
    const temperature = config.temperature ?? 0.7;
    const maxTokens = config.maxTokens || model.tokenLimit || 4096;
    const language = context.language || 'en';

    let currentMessages = [...messages];
    let iteration = 0;
    let finalContent = '';
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

      this.logger.debug({
        component: 'AgentNodeExecutor',
        message: `LLM iteration ${iteration} for node '${nodeId}'`,
        nodeId,
        messageCount: currentMessages.length
      });

      // Execute the request using the helper (filters invalid options like user, chatId)
      const response = await this.llmHelper.executeStreamingRequest({
        model,
        messages: currentMessages,
        apiKey,
        options: {
          temperature,
          maxTokens,
          tools: tools.length > 0 ? tools : undefined
          // Note: user and chatId are intentionally NOT passed here
          // They are not valid adapter options and would corrupt provider request bodies
        },
        language
      });

      // Accumulate content
      if (response.content) {
        finalContent += response.content;
      }

      // Accumulate token usage from response (or estimate if not provided)
      if (response.usage) {
        totalTokens.input += response.usage.prompt_tokens || response.usage.input_tokens || 0;
        totalTokens.output += response.usage.completion_tokens || response.usage.output_tokens || 0;
      } else {
        // Fallback: estimate tokens when usage data is not provided (streaming responses)
        // This matches the approach used in StreamingHandler for chat apps
        const inputText = currentMessages.map(m => m.content || '').join(' ');
        totalTokens.input += estimateTokens(inputText);
        if (response.content) {
          totalTokens.output += estimateTokens(response.content);
        }
      }

      // Check if there are tool calls to process
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No tool calls, we're done
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

      // Continue to next iteration
    }

    if (iteration >= maxIterations) {
      this.logger.warn({
        component: 'AgentNodeExecutor',
        message: `Max iterations (${maxIterations}) reached for node '${nodeId}'`,
        nodeId
      });
    }

    return {
      content: finalContent,
      iterations: iteration,
      tokens: totalTokens
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

    // Find the actual tool ID
    const toolId =
      tools.find(t => normalizeToolName(t.id) === toolCall.function.name)?.id ||
      toolCall.function.name;

    // Parse arguments
    let args = {};
    try {
      if (toolCall.function.arguments) {
        args = JSON.parse(toolCall.function.arguments);
      }
    } catch (e) {
      this.logger.warn({
        component: 'AgentNodeExecutor',
        message: `Failed to parse tool arguments for ${toolId}`,
        error: e.message
      });
    }

    try {
      const result = await runTool(toolId, {
        ...args,
        chatId,
        user,
        appConfig
      });

      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      };
    } catch (error) {
      this.logger.error({
        component: 'AgentNodeExecutor',
        message: `Tool execution failed: ${toolId}`,
        error: error.message
      });

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
   * Parse structured output according to a JSON schema.
   *
   * @param {string} content - Raw LLM response content
   * @param {Object} schema - JSON schema for validation
   * @param {string} nodeId - Node ID for error reporting
   * @returns {*} Parsed output
   * @private
   */
  parseStructuredOutput(content, schema, nodeId) {
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
      this.logger.warn({
        component: 'AgentNodeExecutor',
        message: `Could not parse structured output for node '${nodeId}', returning raw content`,
        nodeId
      });
      return content;
    } catch (error) {
      this.logger.warn({
        component: 'AgentNodeExecutor',
        message: `JSON parse error for node '${nodeId}': ${error.message}`,
        nodeId
      });
      return content;
    }
  }
}

export default AgentNodeExecutor;
