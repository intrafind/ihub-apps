import { getAdapter, createCompletionRequest } from '../adapters/index.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config({ path: '../.env' });

console.log('📋 Comprehensive API Documentation Test\n');
console.log('This test documents ALL messages, requests, and responses for each provider');
console.log('to analyze API differences and verify tool calling behavior.\n');

// Create logs directory
const logsDir = path.join(process.cwd(), 'tests', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// API Keys
const apiKeys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  mistral: process.env.MISTRAL_API_KEY
};

// Test models with configurable base URLs
const testModels = {
  openai: {
    modelId: process.env.OPENAI_MODEL_ID || 'gpt-4o-mini',
    url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
    provider: 'openai'
  },
  anthropic: {
    modelId: process.env.ANTHROPIC_MODEL_ID || 'claude-3-haiku-20240307',
    url: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic'
  },
  google: {
    modelId: process.env.GOOGLE_MODEL_ID || 'gemini-1.5-flash',
    url:
      process.env.GOOGLE_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    provider: 'google'
  },
  mistral: {
    modelId: process.env.MISTRAL_MODEL_ID || 'mistral-small-latest',
    url: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1/chat/completions',
    provider: 'mistral'
  }
};

// Test tools
const testTools = [
  {
    id: 'web_search',
    name: 'web_search',
    description: 'Search the web for information about a specific topic',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to execute'
        },
        num_results: {
          type: 'integer',
          description: 'Number of results to return (default: 5)',
          default: 5
        }
      },
      required: ['query']
    }
  },
  {
    id: 'calculator',
    name: 'calculator',
    description: 'Perform mathematical calculations',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate'
        }
      },
      required: ['expression']
    }
  }
];

// Full conversation flow scenario
const conversationScenarios = [
  {
    name: 'full_conversation_flow',
    description: 'Complete conversation: Q->A->Q->Tools->A->Q->Tools->A->Q->Final',
    messages: [
      {
        role: 'user',
        content: 'Hello! I need help choosing between React and Vue.js for my new project.'
      }
    ]
  }
];

/**
 * Document a complete API interaction with full conversation flow
 */
async function documentAPIInteraction(provider, model, messages, tools, scenarioName) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(
    logsDir,
    `${provider}_${scenarioName}_${timestamp.replace(/[:.]/g, '-')}.json`
  );

  const documentation = {
    timestamp,
    provider,
    scenario: scenarioName,
    model_config: model,
    api_key_status: apiKeys[provider] ? 'SET' : 'MISSING',
    input_messages: messages,
    input_tools: tools,
    interactions: [],
    conversation_flow: []
  };

  if (!apiKeys[provider]) {
    console.log(`❌ ${provider.toUpperCase()}: API key not set, skipping`);
    documentation.error = 'API key not set';
    fs.writeFileSync(logFile, JSON.stringify(documentation, null, 2));
    return documentation;
  }

  console.log(`\n🔄 Documenting ${provider.toUpperCase()} - ${scenarioName}`);

  try {
    // Step 1: Initial greeting and question
    const step1Response = await makeAPICall(
      provider,
      model,
      messages,
      tools,
      documentation,
      'STEP_1_GREETING'
    );
    if (!step1Response.success) return documentation;

    // Step 2: Ask for tool-requiring question
    const step2Messages = [
      ...messages,
      { role: 'assistant', content: step1Response.assistantMessage },
      {
        role: 'user',
        content:
          'Can you search for "React vs Vue.js performance comparison 2024" and also calculate the market share difference if React has 40% and Vue has 15%?'
      }
    ];
    const step2Response = await makeAPICall(
      provider,
      model,
      step2Messages,
      tools,
      documentation,
      'STEP_2_DUAL_TOOLS'
    );
    if (!step2Response.success) return documentation;

    // Step 3: Process tool calls and continue conversation
    const step3Messages = buildMessagesWithToolResponses(
      provider,
      step2Messages,
      step2Response.toolCalls,
      step2Response.assistantMessage
    );
    const step3Response = await makeAPICall(
      provider,
      model,
      step3Messages,
      tools,
      documentation,
      'STEP_3_TOOL_RESPONSE'
    );
    if (!step3Response.success) return documentation;

    // Step 4: Ask follow-up question requiring tools
    const step4Messages = [
      ...step3Messages,
      { role: 'assistant', content: step3Response.assistantMessage },
      {
        role: 'user',
        content:
          'Based on that information, can you search for "Vue.js vs React learning curve 2024" and calculate how long it would take to learn both if Vue takes 3 months and React takes 4 months?'
      }
    ];
    const step4Response = await makeAPICall(
      provider,
      model,
      step4Messages,
      tools,
      documentation,
      'STEP_4_SECOND_DUAL_TOOLS'
    );
    if (!step4Response.success) return documentation;

    // Step 5: Process second set of tool calls
    const step5Messages = buildMessagesWithToolResponses(
      provider,
      step4Messages,
      step4Response.toolCalls,
      step4Response.assistantMessage
    );
    const step5Response = await makeAPICall(
      provider,
      model,
      step5Messages,
      tools,
      documentation,
      'STEP_5_SECOND_TOOL_RESPONSE'
    );
    if (!step5Response.success) return documentation;

    // Step 6: Final question and recommendation
    const step6Messages = [
      ...step5Messages,
      { role: 'assistant', content: step5Response.assistantMessage },
      {
        role: 'user',
        content:
          'Given all this information, what would be your final recommendation for my project?'
      }
    ];
    await makeAPICall(
      provider,
      model,
      step6Messages,
      tools,
      documentation,
      'STEP_6_FINAL_RECOMMENDATION'
    );

    console.log(`  ✅ Full conversation flow completed for ${provider.toUpperCase()}`);
    console.log(`  📄 Documentation saved to: ${logFile}`);
  } catch (error) {
    console.log(`  ❌ Error in ${provider.toUpperCase()}: ${error.message}`);
    documentation.error = error.message;
  }

  // Save documentation
  fs.writeFileSync(logFile, JSON.stringify(documentation, null, 2));
  return documentation;
}

/**
 * Make an API call and document the interaction
 */
async function makeAPICall(provider, model, messages, tools, documentation, stepName) {
  getAdapter(provider);
  const requestData = createCompletionRequest(model, messages, apiKeys[provider], {
    temperature: 0.1,
    stream: false,
    maxTokens: 1000,
    tools: tools
  });

  const { url: requestUrl, ...requestOptions } = requestData;
  const requestHeaders = requestOptions.headers;
  const requestBody = requestOptions.body;

  // Log the request
  documentation.interactions.push({
    step: stepName,
    type: 'REQUEST',
    url: requestUrl,
    method: requestOptions.method,
    headers: requestHeaders,
    body: requestBody
  });

  console.log(`  📤 ${stepName}: Making API call...`);

  // Prepare request options for fetch
  const fetchOptions = {
    method: requestOptions.method,
    headers: requestHeaders,
    body: typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody)
  };

  // Make the API call
  const response = await fetch(requestUrl, fetchOptions);
  const responseData = await response.json();

  // Log the response
  documentation.interactions.push({
    step: stepName,
    type: 'RESPONSE',
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseData
  });

  if (!response.ok) {
    console.log(`  ❌ ${stepName}: API call failed - ${response.status}`);
    return { success: false, error: responseData };
  }

  // Extract tool calls and assistant message
  const toolCallAnalysis = extractToolCalls(provider, responseData);
  const assistantMessage = toolCallAnalysis.content;
  const toolCalls = toolCallAnalysis.toolCalls;

  // Log conversation step
  documentation.conversation_flow.push({
    step: stepName,
    assistant_message: assistantMessage,
    tool_calls: toolCalls,
    tool_call_count: toolCalls.length
  });

  console.log(`  📥 ${stepName}: Got response, ${toolCalls.length} tool calls`);

  return {
    success: true,
    assistantMessage,
    toolCalls,
    responseData
  };
}

/**
 * Build messages with tool responses for different providers
 */
function buildMessagesWithToolResponses(provider, messages, toolCalls, assistantContent) {
  const newMessages = [...messages];

  if (toolCalls.length === 0) {
    // No tool calls, just add assistant message
    newMessages.push({ role: 'assistant', content: assistantContent });
    return newMessages;
  }

  // Simulate tool responses
  const toolResponses = toolCalls.map(call => {
    let toolName, toolArgs;

    if (call.functionCall) {
      // Google format
      toolName = call.functionCall.name;
      toolArgs = call.functionCall.args;
    } else if (call.function) {
      // OpenAI/Mistral format
      toolName = call.function.name;
      toolArgs = call.function.arguments;
    } else {
      // Anthropic format
      toolName = call.name;
      toolArgs = call.input;
    }

    return {
      id: call.id,
      name: toolName,
      result: simulateToolResponse(toolName, toolArgs)
    };
  });

  // Add assistant message with tool calls and tool responses based on provider
  switch (provider) {
    case 'openai':
      newMessages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function?.name || call.name,
            arguments:
              typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.arguments || {})
          }
        }))
      });

      // Add tool responses
      toolResponses.forEach(response => {
        newMessages.push({
          role: 'tool',
          content: JSON.stringify(response.result),
          tool_call_id: response.id
        });
      });
      break;

    case 'mistral':
      newMessages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.map(call => ({
          id: call.id,
          function: {
            name: call.function?.name || call.name,
            arguments:
              typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.arguments || {})
          }
        }))
      });

      // Add tool responses
      toolResponses.forEach(response => {
        newMessages.push({
          role: 'tool',
          content: JSON.stringify(response.result),
          tool_call_id: response.id
        });
      });

      // Mistral requires assistant response after tool calls
      newMessages.push({
        role: 'assistant',
        content: 'I have the information from the tools. Let me analyze this for you.'
      });
      break;

    case 'anthropic':
      const content = [];
      if (assistantContent) {
        content.push({ type: 'text', text: assistantContent });
      }
      toolCalls.forEach(call => {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input || call.arguments || {}
        });
      });
      newMessages.push({ role: 'assistant', content });

      // Add tool responses
      if (toolResponses.length > 0) {
        const toolResults = toolResponses.map(response => ({
          type: 'tool_result',
          tool_use_id: response.id,
          content: JSON.stringify(response.result)
        }));
        newMessages.push({ role: 'user', content: toolResults });
      }
      break;

    case 'google':
      const parts = [];
      if (assistantContent) {
        parts.push({ text: assistantContent });
      }
      toolCalls.forEach(call => {
        parts.push({
          functionCall: {
            name: call.functionCall?.name || call.name,
            args: call.functionCall?.args || call.arguments || {}
          }
        });
      });
      newMessages.push({ role: 'model', parts });

      // Add tool responses
      if (toolResponses.length > 0) {
        const functionResponses = toolResponses.map(response => ({
          functionResponse: {
            name: response.name,
            response: response.result
          }
        }));
        newMessages.push({ role: 'user', parts: functionResponses });
      }
      break;
  }

  return newMessages;
}

/**
 * Extract tool calls from provider response
 */
function extractToolCalls(provider, responseData) {
  let toolCalls = [];
  let content = '';

  try {
    switch (provider) {
      case 'openai':
      case 'mistral':
        const choice = responseData.choices?.[0];
        if (choice?.message) {
          content = choice.message.content || '';
          toolCalls = choice.message.tool_calls || [];
        }
        break;

      case 'anthropic':
        if (responseData.content) {
          const textContent = responseData.content.find(c => c.type === 'text');
          content = textContent?.text || '';
          toolCalls = responseData.content.filter(c => c.type === 'tool_use');
        }
        break;

      case 'google':
        const candidate = responseData.candidates?.[0];
        if (candidate?.content?.parts) {
          const textPart = candidate.content.parts.find(p => p.text);
          content = textPart?.text || '';
          toolCalls = candidate.content.parts.filter(p => p.functionCall);
        }
        break;
    }
  } catch (error) {
    console.log(`Error extracting tool calls for ${provider}: ${error.message}`);
  }

  return { toolCalls, content };
}

/**
 * Simulate tool response based on tool name and arguments
 */
function simulateToolResponse(toolName, args) {
  // Handle different argument formats from different providers
  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = { raw: args };
    }
  }

  switch (toolName) {
    case 'web_search':
      const query = parsedArgs.query || 'default query';

      // Different responses based on query content
      if (query.includes('React vs Vue.js performance')) {
        return {
          results: [
            {
              title: 'React vs Vue.js Performance Comparison 2024',
              url: 'https://example.com/react-vue-performance',
              snippet:
                'React shows 15% better performance in large applications with complex state management...'
            },
            {
              title: 'Vue.js vs React: Benchmark Results',
              url: 'https://example.com/vue-react-benchmarks',
              snippet: 'Vue.js has 20% faster initial load times and smaller bundle sizes...'
            },
            {
              title: 'JavaScript Framework Performance Guide 2024',
              url: 'https://example.com/js-frameworks-2024',
              snippet:
                'Both frameworks show excellent performance with React excelling in large apps...'
            }
          ],
          query: query
        };
      } else if (query.includes('learning curve')) {
        return {
          results: [
            {
              title: 'Vue.js vs React Learning Curve Analysis 2024',
              url: 'https://example.com/learning-curve-comparison',
              snippet:
                'Vue.js has a gentler learning curve with simpler syntax and better documentation...'
            },
            {
              title: 'Developer Survey: Framework Learning Difficulty',
              url: 'https://example.com/developer-survey-2024',
              snippet: 'Survey shows Vue.js takes 30% less time to learn compared to React...'
            },
            {
              title: 'Complete Guide to Learning Modern JS Frameworks',
              url: 'https://example.com/framework-learning-guide',
              snippet: 'Vue.js: 2-3 months, React: 3-4 months for intermediate proficiency...'
            }
          ],
          query: query
        };
      } else {
        return {
          results: [
            {
              title: 'Search Results for: ' + query,
              url: 'https://example.com/search-results',
              snippet: 'General search results for the query: ' + query
            }
          ],
          query: query
        };
      }

    case 'calculator':
      try {
        const expression = parsedArgs.expression || parsedArgs.raw || '0';
        let result;

        // Handle specific calculations
        if (expression.includes('40') && expression.includes('15')) {
          result = 25; // 40 - 15 = 25
        } else if (expression.includes('3') && expression.includes('4')) {
          result = 7; // 3 + 4 = 7
        } else {
          // Simple eval for basic expressions
          result = eval(expression);
        }

        return {
          result,
          expression,
          unit: expression.includes('month') ? 'months' : 'number'
        };
      } catch {
        return {
          error: 'Invalid expression',
          expression: parsedArgs.expression || parsedArgs.raw
        };
      }

    default:
      return { message: `Tool ${toolName} executed with args: ${JSON.stringify(parsedArgs)}` };
  }
}

/**
 * Generate comparison report across all providers
 */
async function generateComparisonReport(allResults) {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_providers: Object.keys(allResults).length,
      successful_calls: 0,
      providers_with_tool_calls: 0,
      total_tool_calls: 0,
      total_conversation_steps: 0
    },
    provider_comparison: {},
    conversation_analysis: {}
  };

  // Analyze each provider
  Object.entries(allResults).forEach(([provider, results]) => {
    const providerSummary = {
      successful_scenarios: 0,
      failed_scenarios: 0,
      total_api_calls: 0,
      total_tool_calls: 0,
      conversation_steps: 0
    };

    Object.entries(results).forEach(([, result]) => {
      if (result.error) {
        providerSummary.failed_scenarios++;
      } else {
        providerSummary.successful_scenarios++;
        providerSummary.total_api_calls = result.interactions.filter(
          i => i.type === 'REQUEST'
        ).length;

        // Count tool calls across all conversation steps
        if (result.conversation_flow) {
          result.conversation_flow.forEach(step => {
            providerSummary.total_tool_calls += step.tool_call_count;
          });
          providerSummary.conversation_steps = result.conversation_flow.length;
        }

        report.summary.successful_calls += providerSummary.total_api_calls;
        report.summary.total_tool_calls += providerSummary.total_tool_calls;
        report.summary.total_conversation_steps += providerSummary.conversation_steps;
      }
    });

    if (providerSummary.total_tool_calls > 0) {
      report.summary.providers_with_tool_calls++;
    }

    report.provider_comparison[provider] = providerSummary;

    // Analyze conversation flow
    if (results.full_conversation_flow && results.full_conversation_flow.conversation_flow) {
      report.conversation_analysis[provider] = {
        steps: results.full_conversation_flow.conversation_flow.map(step => ({
          step: step.step,
          tool_calls: step.tool_call_count,
          has_assistant_response: !!step.assistant_message
        }))
      };
    }
  });

  // Save report
  const reportFile = path.join(
    logsDir,
    `comparison_report_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`📊 Comparison report saved to: ${reportFile}`);

  return report;
}

/**
 * Main test execution
 */
async function runComprehensiveDocumentation() {
  console.log('🚀 Starting comprehensive API documentation...\n');

  const allResults = {};

  // Test each provider with the full conversation scenario
  for (const [provider, model] of Object.entries(testModels)) {
    console.log(`\n🔍 Testing ${provider.toUpperCase()}`);
    allResults[provider] = {};

    for (const scenario of conversationScenarios) {
      const result = await documentAPIInteraction(
        provider,
        model,
        scenario.messages,
        testTools,
        scenario.name
      );

      allResults[provider][scenario.name] = result;

      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Generate comparison report
  const report = await generateComparisonReport(allResults);

  console.log('\n📋 DOCUMENTATION COMPLETE!');
  console.log(`\nResults summary:`);
  console.log(`- Total providers tested: ${report.summary.total_providers}`);
  console.log(`- Successful API calls: ${report.summary.successful_calls}`);
  console.log(`- Providers that made tool calls: ${report.summary.providers_with_tool_calls}`);
  console.log(`- Total tool calls made: ${report.summary.total_tool_calls}`);
  console.log(`- Total conversation steps: ${report.summary.total_conversation_steps}`);
  console.log(`\nAll logs saved to: ${logsDir}`);

  return { allResults, report };
}

// Run the comprehensive documentation
runComprehensiveDocumentation().catch(console.error);
