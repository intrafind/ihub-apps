import { getAdapter, createCompletionRequest } from '../adapters/index.js';
import { loadConfiguredTools } from '../toolLoader.js';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config({ path: '../.env' });

// Set up real environment variables
console.log('🔧 Real LLM Integration Test - Tool Calling with Actual API Calls\n');

// Check if API keys are set
const apiKeys = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  mistral: process.env.MISTRAL_API_KEY
};

console.log('API Keys Status:');
Object.entries(apiKeys).forEach(([provider, key]) => {
  console.log(`${provider}: ${key ? '✅ Set' : '❌ Not set'}`);
});

console.log('\nBase URLs Configuration:');
console.log(
  `OpenAI: ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions (default)'}`
);
console.log(
  `Anthropic: ${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages (default)'}`
);
console.log(
  `Google: ${process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent (default)'}`
);
console.log(
  `Mistral: ${process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1/chat/completions (default)'}`
);

console.log('\nModel IDs:');
console.log(`OpenAI: ${process.env.OPENAI_MODEL_ID || 'gpt-4o-mini (default)'}`);
console.log(`Anthropic: ${process.env.ANTHROPIC_MODEL_ID || 'claude-3-haiku-20240307 (default)'}`);
console.log(`Google: ${process.env.GOOGLE_MODEL_ID || 'gemini-1.5-flash (default)'}`);
console.log(`Mistral: ${process.env.MISTRAL_MODEL_ID || 'mistral-small-latest (default)'}`);
console.log();

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
    console.log(`❌ ${provider}: API key not set, skipping`);
    return;
  }

  try {
    console.log(`\n🔄 Making real API call to ${provider.toUpperCase()}...`);

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

    console.log(`✅ ${provider}: SUCCESS`);
    console.log(`   Content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
    console.log(`   Tool calls: ${toolCalls.length}`);

    if (toolCalls.length > 0) {
      console.log(`   Tool called: ${JSON.stringify(toolCalls[0])}`);
    }

    return { success: true, toolCalls, content };
  } catch (error) {
    console.log(`❌ ${provider}: ERROR - ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runRealIntegrationTests() {
  console.log('\n📋 Loading configured tools...');
  let tools = [];

  try {
    tools = await loadConfiguredTools();
    console.log(`✅ Loaded ${tools.length} tools`);
  } catch (error) {
    console.log(`⚠️  Could not load tools: ${error.message}`);
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
    console.log('Using fallback test tool');
  }

  const testMessage = [
    {
      role: 'user',
      content: 'Please use a tool to search for information about "JavaScript frameworks"'
    }
  ];

  console.log('\n📊 Testing Real API Calls with Tool Calling:\n');

  const results = {};

  for (const [provider, model] of Object.entries(testModels)) {
    results[provider] = await makeRealAPICall(provider, model, testMessage, tools);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
  }

  console.log('\n📈 Test Results Summary:');
  let successCount = 0;
  let toolCallCount = 0;

  Object.entries(results).forEach(([provider, result]) => {
    if (result?.success) {
      successCount++;
      if (result.toolCalls?.length > 0) {
        toolCallCount++;
      }
    }
  });

  console.log(`✅ Successful API calls: ${successCount}/4`);
  console.log(`🔧 Providers that made tool calls: ${toolCallCount}/4`);

  if (successCount === 0) {
    console.log('\n❌ No successful API calls. Please check your API keys.');
  } else if (toolCallCount === 0) {
    console.log('\n⚠️  No tool calls were made. This might indicate:');
    console.log('   - Tools are not properly configured');
    console.log('   - Models chose not to use tools');
    console.log('   - Tool calling is not enabled for these models');
  } else {
    console.log('\n🎉 Tool calling is working across adapters!');
  }
}

// Run the test
runRealIntegrationTests().catch(console.error);
