import { createCompletionRequest } from '../adapters/index.js';
import { loadConfiguredTools } from '../toolLoader.js';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

// Load environment variables from .env file
dotenv.config({ path: '../.env' });

// Set up real environment variables
logger.info('🔧 Real LLM Integration Test - Tool Calling with Actual API Calls\n');

// Check if API keys are set
const apiKeys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  mistral: process.env.MISTRAL_API_KEY
};

logger.info('API Keys Status:');
Object.entries(apiKeys).forEach(([provider, key]) => {
  logger.info(`${provider}: ${key ? '✅ Set' : '❌ Not set'}`);
});

logger.info('\nBase URLs Configuration:');
logger.info(
  `OpenAI: ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions (default)'}`
);
logger.info(
  `Anthropic: ${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages (default)'}`
);
logger.info(
  `Google: ${process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent (default)'}`
);
logger.info(
  `Mistral: ${process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1/chat/completions (default)'}`
);

logger.info('\nModel IDs:');
logger.info(`OpenAI: ${process.env.OPENAI_MODEL_ID || 'gpt-4o-mini (default)'}`);
logger.info(`Anthropic: ${process.env.ANTHROPIC_MODEL_ID || 'claude-3-haiku-20240307 (default)'}`);
logger.info(`Google: ${process.env.GOOGLE_MODEL_ID || 'gemini-1.5-flash (default)'}`);
logger.info(`Mistral: ${process.env.MISTRAL_MODEL_ID || 'mistral-small-latest (default)'}`);
logger.info();

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

async function makeRealAPICall(provider, model, messages, tools) {
  if (!apiKeys[provider]) {
    logger.info(`❌ ${provider}: API key not set, skipping`);
    return;
  }

  try {
    logger.info(`\n🔄 Making real API call to ${provider.toUpperCase()}...`);

    const request = createCompletionRequest(model, messages, apiKeys[provider], {
      tools: tools.slice(0, 2), // Use first 2 tools to avoid overwhelming
      temperature: 0.1,
      maxTokens: 500,
      stream: false // Disable streaming for easier testing
    });

    // Handle different authentication methods
    const headers = { ...request.headers };

    if (provider === 'openai') {
      // For Azure OpenAI, use api-key header if URL contains azure.com
      if (request.url.includes('azure.com')) {
        headers['api-key'] = apiKeys[provider];
      } else {
        headers['Authorization'] = `Bearer ${apiKeys[provider]}`;
      }
    } else {
      headers['Authorization'] = `Bearer ${apiKeys[provider]}`;
    }

    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Extract tool calls from response
    let toolCalls = [];
    let content = '';

    if (provider === 'openai' || provider === 'mistral') {
      const choice = data.choices?.[0];
      content = choice?.message?.content || '';
      toolCalls = choice?.message?.tool_calls || [];
    } else if (provider === 'anthropic') {
      content = data.content?.find(c => c.type === 'text')?.text || '';
      toolCalls = data.content?.filter(c => c.type === 'tool_use') || [];
    } else if (provider === 'google') {
      const candidate = data.candidates?.[0];
      content = candidate?.content?.parts?.find(p => p.text)?.text || '';
      toolCalls = candidate?.content?.parts?.filter(p => p.functionCall) || [];
    }

    logger.info(`✅ ${provider}: SUCCESS`);
    logger.info(`   Content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
    logger.info(`   Tool calls: ${toolCalls.length}`);

    if (toolCalls.length > 0) {
      logger.info(`   Tool called: ${JSON.stringify(toolCalls[0])}`);
    }

    return { success: true, toolCalls, content };
  } catch (error) {
    logger.info(`❌ ${provider}: ERROR - ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runRealIntegrationTests() {
  logger.info('\n📋 Loading configured tools...');
  let tools = [];

  try {
    tools = await loadConfiguredTools();
    logger.info(`✅ Loaded ${tools.length} tools`);
  } catch (error) {
    logger.info(`⚠️  Could not load tools: ${error.message}`);
    // Create a simple test tool
    tools = [
      {
        id: 'test_tool',
        name: 'test_tool',
        description: 'A simple test tool',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A test query' }
          },
          required: ['query']
        }
      }
    ];
    logger.info('Using fallback test tool');
  }

  const testMessage = [
    {
      role: 'user',
      content: 'Please use a tool to search for information about "JavaScript frameworks"'
    }
  ];

  logger.info('\n📊 Testing Real API Calls with Tool Calling:\n');

  const results = {};

  for (const [provider, model] of Object.entries(testModels)) {
    results[provider] = await makeRealAPICall(provider, model, testMessage, tools);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }

  logger.info('\n📈 Test Results Summary:');
  let successCount = 0;
  let toolCallCount = 0;

  Object.entries(results).forEach(([, result]) => {
    if (result?.success) {
      successCount++;
      if (result.toolCalls?.length > 0) {
        toolCallCount++;
      }
    }
  });

  logger.info(`✅ Successful API calls: ${successCount}/4`);
  logger.info(`🔧 Providers that made tool calls: ${toolCallCount}/4`);

  if (successCount === 0) {
    logger.info('\n❌ No successful API calls. Please check your API keys.');
  } else if (toolCallCount === 0) {
    logger.info('\n⚠️  No tool calls were made. This might indicate:');
    logger.info('   - Tools are not properly configured');
    logger.info('   - Models chose not to use tools');
    logger.info('   - Tool calling is not enabled for these models');
  } else {
    logger.info('\n🎉 Tool calling is working across adapters!');
  }
}

// Run the test
runRealIntegrationTests().catch(logger.error);
