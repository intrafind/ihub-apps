import { createCompletionRequest } from '../adapters/index.js';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

// Load environment variables
dotenv.config({ path: '../.env' });

logger.info('🔍 Tool Call Verification Test\n');
logger.info('This test specifically verifies that LLMs actually want to call tools');
logger.info('and documents the exact format differences between providers.\n');

// API configuration
const apiKeys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  mistral: process.env.MISTRAL_API_KEY
};

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

// Test tools that LLMs should want to use
const testTools = [
  {
    id: 'get_weather',
    name: 'get_weather',
    description: 'Get current weather information for a specific location',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City and country, e.g., "London, UK"'
        },
        unit: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Temperature unit',
          default: 'celsius'
        }
      },
      required: ['location']
    }
  }
];

// Test messages designed to trigger tool calls
const toolCallPrompts = [
  {
    name: 'direct_weather_request',
    message: 'What is the current weather in Paris, France?',
    expectedTool: 'get_weather',
    shouldCallTool: true
  },
  {
    name: 'indirect_weather_request',
    message: 'I am planning a trip to Tokyo. Can you help me check the weather there?',
    expectedTool: 'get_weather',
    shouldCallTool: true
  },
  {
    name: 'no_tool_needed',
    message: 'What is the capital of France?',
    expectedTool: null,
    shouldCallTool: false
  }
];

/**
 * Test a single provider with a specific prompt
 */
async function testProviderToolCall(provider, model, prompt, tools) {
  if (!apiKeys[provider]) {
    return {
      provider,
      prompt: prompt.name,
      status: 'skipped',
      reason: 'API key not set'
    };
  }

  try {
    logger.info(`\n🧪 Testing ${provider.toUpperCase()} - ${prompt.name}`);
    logger.info(`   Message: "${prompt.message}"`);
    logger.info(`   Expected tool call: ${prompt.shouldCallTool ? prompt.expectedTool : 'none'}`);

    // Create request
    const request = createCompletionRequest(
      model,
      [{ role: 'user', content: prompt.message }],
      apiKeys[provider],
      {
        tools: tools,
        temperature: 0.1,
        maxTokens: 500,
        stream: false
      }
    );

    logger.info(`\n📤 REQUEST TO ${provider.toUpperCase()}:`);
    logger.info(`   URL: ${request.url}`);
    logger.info(`   Method: ${request.method}`);
    logger.info(`   Headers: ${JSON.stringify(request.headers, null, 4)}`);
    logger.info(`   Body: ${JSON.stringify(request.body, null, 4)}`);

    // Make API call
    const headers = { ...request.headers };
    if (provider === 'openai' && request.url.includes('azure.com')) {
      delete headers.Authorization;
      headers['api-key'] = apiKeys[provider];
    }

    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body)
    });

    const responseText = await response.text();

    logger.info(`\n📥 RESPONSE FROM ${provider.toUpperCase()}:`);
    logger.info(`   Status: ${response.status} ${response.statusText}`);
    logger.info(
      `   Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()), null, 4)}`
    );

    if (!response.ok) {
      logger.info(`   Body: ${responseText}`);
      return {
        provider,
        prompt: prompt.name,
        status: 'error',
        error: `HTTP ${response.status}: ${responseText}`
      };
    }

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      logger.info(`   Body (raw): ${responseText}`);
      return {
        provider,
        prompt: prompt.name,
        status: 'error',
        error: `Failed to parse JSON: ${e.message}`
      };
    }

    logger.info(`   Body: ${JSON.stringify(responseData, null, 4)}`);

    // Analyze response for tool calls
    const analysis = analyzeToolCalls(provider, responseData);

    logger.info(`\n🔍 ANALYSIS FOR ${provider.toUpperCase()}:`);
    logger.info(
      `   Content: "${analysis.content.substring(0, 100)}${analysis.content.length > 100 ? '...' : ''}"`
    );
    logger.info(`   Tool calls found: ${analysis.toolCalls.length}`);
    logger.info(`   Expected tool calls: ${prompt.shouldCallTool ? 1 : 0}`);
    logger.info(
      `   Match expectation: ${analysis.toolCalls.length > 0 === prompt.shouldCallTool ? '✅' : '❌'}`
    );

    if (analysis.toolCalls.length > 0) {
      logger.info(`   Tool call details:`);
      analysis.toolCalls.forEach((call, index) => {
        logger.info(`     ${index + 1}. Tool: ${call.name || 'unknown'}`);
        logger.info(`        ID: ${call.id || 'none'}`);
        logger.info(`        Arguments: ${JSON.stringify(call.arguments || {}, null, 8)}`);
      });
    }

    return {
      provider,
      prompt: prompt.name,
      status: 'success',
      expected_tool_call: prompt.shouldCallTool,
      actual_tool_calls: analysis.toolCalls.length,
      matches_expectation: analysis.toolCalls.length > 0 === prompt.shouldCallTool,
      content: analysis.content,
      tool_calls: analysis.toolCalls,
      raw_response: responseData
    };
  } catch (error) {
    logger.info(`   ❌ Error: ${error.message}`);
    return {
      provider,
      prompt: prompt.name,
      status: 'error',
      error: error.message
    };
  }
}

/**
 * Analyze response for tool calls based on provider format
 */
function analyzeToolCalls(provider, responseData) {
  let toolCalls = [];
  let content = '';

  try {
    switch (provider) {
      case 'openai':
      case 'mistral':
        const choice = responseData.choices?.[0];
        if (choice?.message) {
          content = choice.message.content || '';
          if (choice.message.tool_calls) {
            toolCalls = choice.message.tool_calls.map(call => ({
              id: call.id,
              name: call.function?.name,
              arguments: call.function?.arguments ? JSON.parse(call.function.arguments) : {}
            }));
          }
        }
        break;

      case 'anthropic':
        if (responseData.content) {
          const textContent = responseData.content.find(c => c.type === 'text');
          content = textContent?.text || '';

          const toolUseBlocks = responseData.content.filter(c => c.type === 'tool_use');
          toolCalls = toolUseBlocks.map(block => ({
            id: block.id,
            name: block.name,
            arguments: block.input || {}
          }));
        }
        break;

      case 'google':
        const candidate = responseData.candidates?.[0];
        if (candidate?.content?.parts) {
          const textPart = candidate.content.parts.find(p => p.text);
          content = textPart?.text || '';

          const functionCalls = candidate.content.parts.filter(p => p.functionCall);
          toolCalls = functionCalls.map(call => ({
            id: `google_${Date.now()}_${Math.random()}`, // Google doesn't provide IDs
            name: call.functionCall?.name,
            arguments: call.functionCall?.args || {}
          }));
        }
        break;
    }
  } catch (error) {
    logger.info(`Error analyzing tool calls for ${provider}: ${error.message}`);
  }

  return { toolCalls, content };
}

/**
 * Generate summary report
 */
function generateSummaryReport(allResults) {
  logger.info('\n📊 TOOL CALL VERIFICATION SUMMARY\n');

  const summary = {
    total_tests: 0,
    successful_tests: 0,
    matching_expectations: 0,
    providers_tested: new Set(),
    tool_call_accuracy: {}
  };

  // Analyze results
  allResults.forEach(result => {
    summary.total_tests++;
    summary.providers_tested.add(result.provider);

    if (result.status === 'success') {
      summary.successful_tests++;

      if (result.matches_expectation) {
        summary.matching_expectations++;
      }

      if (!summary.tool_call_accuracy[result.provider]) {
        summary.tool_call_accuracy[result.provider] = { correct: 0, total: 0 };
      }

      summary.tool_call_accuracy[result.provider].total++;
      if (result.matches_expectation) {
        summary.tool_call_accuracy[result.provider].correct++;
      }
    }
  });

  // Print summary
  logger.info(`Total tests run: ${summary.total_tests}`);
  logger.info(`Successful API calls: ${summary.successful_tests}/${summary.total_tests}`);
  logger.info(
    `Tests matching expectations: ${summary.matching_expectations}/${summary.successful_tests}`
  );
  logger.info(`Providers tested: ${Array.from(summary.providers_tested).join(', ')}`);

  logger.info('\nProvider accuracy:');
  Object.entries(summary.tool_call_accuracy).forEach(([provider, accuracy]) => {
    const percentage = Math.round((accuracy.correct / accuracy.total) * 100);
    logger.info(`  ${provider}: ${accuracy.correct}/${accuracy.total} (${percentage}%)`);
  });

  // Group results by provider
  const byProvider = {};
  allResults.forEach(result => {
    if (!byProvider[result.provider]) {
      byProvider[result.provider] = [];
    }
    byProvider[result.provider].push(result);
  });

  logger.info('\n📋 Detailed Results by Provider:');
  Object.entries(byProvider).forEach(([provider, results]) => {
    logger.info(`\n${provider.toUpperCase()}:`);
    results.forEach(result => {
      const status =
        result.status === 'success'
          ? result.matches_expectation
            ? '✅'
            : '❌'
          : result.status === 'skipped'
            ? '⏭️'
            : '💥';
      logger.info(
        `  ${status} ${result.prompt}: ${result.status === 'success' ? `${result.actual_tool_calls} tool calls` : result.reason || result.error}`
      );
    });
  });

  return summary;
}

/**
 * Main test execution
 */
async function runToolCallVerification() {
  logger.info('🚀 Starting tool call verification across all providers...\n');

  const allResults = [];

  // Test each provider with each prompt
  for (const [provider, model] of Object.entries(testModels)) {
    for (const prompt of toolCallPrompts) {
      const result = await testProviderToolCall(provider, model, prompt, testTools);
      allResults.push(result);

      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Generate summary
  const summary = generateSummaryReport(allResults);

  logger.info('\n✅ Tool call verification complete!');
  return { allResults, summary };
}

// Run the verification
runToolCallVerification().catch(logger.error);
