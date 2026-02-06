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
import { createCompletionRequest } from '../../../adapters/index.js';
import {
  convertResponseToGeneric,
  normalizeToolName
} from '../../../adapters/toolCalling/index.js';
import { getToolsForApp, runTool } from '../../../toolLoader.js';
import configCache from '../../../configCache.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../../requestThrottler.js';

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

      // Get model configuration
      const model = await this.getModel(config.modelId, context);
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
        hasOutput: output !== undefined
      });

      // Build state updates
      const stateUpdates = config.outputVariable ? { [config.outputVariable]: output } : undefined;

      return this.createSuccessResult(output, { stateUpdates });
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
   * @param {Object} _context - Execution context (reserved for future use)
   * @returns {Array<Object>} Array of message objects
   * @private
   */
  buildMessages(config, state, _context) {
    const messages = [];

    // Add system message if configured
    if (config.system) {
      const systemContent = this.resolveVariables(config.system, state);
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
      userContent = this.resolveVariables(config.prompt, state);
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
   * Get model configuration by ID or use default.
   *
   * @param {string} modelId - Model ID or null for default
   * @param {Object} context - Execution context
   * @returns {Promise<Object|null>} Model configuration or null
   * @private
   */
  async getModel(modelId, context) {
    const { data: models } = configCache.getModels();
    if (!models) {
      return null;
    }

    if (modelId) {
      return models.find(m => m.id === modelId);
    }

    // Use context model or default
    if (context.modelId) {
      return models.find(m => m.id === context.modelId);
    }

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

    let currentMessages = [...messages];
    let iteration = 0;
    let finalContent = '';

    while (iteration < maxIterations) {
      iteration++;

      this.logger.debug({
        component: 'AgentNodeExecutor',
        message: `LLM iteration ${iteration} for node '${nodeId}'`,
        nodeId,
        messageCount: currentMessages.length
      });

      // Get API key for model
      const apiKey = await this.getApiKey(model);

      // Create completion request
      const request = createCompletionRequest(model, currentMessages, apiKey, {
        temperature,
        maxTokens,
        stream: true,
        tools: tools.length > 0 ? tools : undefined,
        user: context.user,
        chatId: context.chatId
      });

      // Execute the request
      const response = await this.executeStreamingRequest(request, model);

      // Accumulate content
      if (response.content) {
        finalContent += response.content;
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
      iterations: iteration
    };
  }

  /**
   * Execute a streaming LLM request and collect the response.
   *
   * @param {Object} request - The request configuration
   * @param {Object} model - Model configuration
   * @returns {Promise<Object>} Collected response with content and tool calls
   * @private
   */
  async executeStreamingRequest(request, model) {
    const response = await throttledFetch(model.id, request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${errorText}`);
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({ onEvent: e => events.push(e) });

    let content = '';
    const toolCalls = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);

      while (events.length > 0) {
        const evt = events.shift();
        const result = convertResponseToGeneric(evt.data, model.provider);

        if (result.error) {
          throw new Error(result.errorMessage || 'Error processing LLM response');
        }

        // Accumulate content
        if (result.content?.length > 0) {
          content += result.content.join('');
        }

        // Collect tool calls
        if (result.tool_calls?.length > 0) {
          this.mergeToolCalls(toolCalls, result.tool_calls);
        }

        if (result.complete) {
          done = true;
          break;
        }
      }
    }

    return { content, toolCalls };
  }

  /**
   * Merge streaming tool call chunks into complete tool calls.
   *
   * @param {Array} collectedCalls - Array of collected tool calls
   * @param {Array} newCalls - New tool call chunks
   * @private
   */
  mergeToolCalls(collectedCalls, newCalls) {
    for (const call of newCalls) {
      let existing = collectedCalls.find(c => c.index === call.index);

      if (existing) {
        if (call.id) existing.id = call.id;
        if (call.type) existing.type = call.type;
        if (call.function) {
          if (call.function.name) existing.function.name = call.function.name;
          if (call.function.arguments) {
            existing.function.arguments += call.function.arguments;
          }
        }
      } else if (call.index !== undefined) {
        collectedCalls.push({
          index: call.index,
          id: call.id || null,
          type: call.type || 'function',
          function: {
            name: call.function?.name || '',
            arguments: call.function?.arguments || ''
          }
        });
      }
    }
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
   * Get API key for a model.
   *
   * @param {Object} model - Model configuration
   * @returns {Promise<string>} API key
   * @private
   */
  async getApiKey(model) {
    // Check for model-specific API key
    if (model.apiKeyEnvVar) {
      return process.env[model.apiKeyEnvVar];
    }

    // Fall back to provider default
    const providerKeyMap = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      google: 'GOOGLE_API_KEY',
      mistral: 'MISTRAL_API_KEY'
    };

    const envVar = providerKeyMap[model.provider];
    return envVar ? process.env[envVar] : '';
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
