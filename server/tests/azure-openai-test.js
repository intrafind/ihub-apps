import dotenv from 'dotenv';
import { createCompletionRequest } from '../adapters/index.js';

// Load environment variables
dotenv.config({ path: '../.env' });

console.log('🔧 Azure OpenAI Configuration Test\n');

// Test Azure OpenAI configuration
const testAzureOpenAI = async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;

  if (!apiKey || !baseUrl) {
    console.log('❌ Missing OPENAI_API_KEY or OPENAI_BASE_URL');
    return;
  }

  console.log('Configuration:');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`API Key: ${apiKey.substring(0, 20)}...`);
  console.log(`Is Azure: ${baseUrl.includes('azure.com') ? 'Yes' : 'No'}`);

  const model = {
    modelId: 'gpt-4o-mini', // This should be ignored for Azure - Azure uses deployment name from URL
    url: baseUrl,
    provider: 'openai'
  };

  const messages = [
    { role: 'user', content: 'Say hello and explain what you are in one sentence.' }
  ];

  try {
    console.log('\n🔄 Creating request...');
    const request = createCompletionRequest(model, messages, apiKey, {
      temperature: 0.1,
      maxTokens: 100,
      stream: false // Disable streaming for simple test
    });

    console.log('Request created successfully:');
    console.log(`URL: ${request.url}`);
    console.log(`Method: ${request.method}`);
    console.log(`Headers: ${JSON.stringify(request.headers, null, 2)}`);
    console.log(`Body: ${JSON.stringify(request.body, null, 2)}`);

    console.log('\n🔄 Making API call...');

    // Handle Azure OpenAI authentication
    const headers = { ...request.headers };
    if (baseUrl.includes('azure.com')) {
      delete headers.Authorization;
      headers['api-key'] = apiKey;
    }

    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body)
    });

    console.log(`Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error response: ${errorText}`);
      return;
    }

    const data = await response.json();
    console.log('\n✅ Response received:');
    console.log(`Content: "${data.choices?.[0]?.message?.content || 'No content'}"`);
    console.log(`Model: ${data.model || 'Unknown'}`);
    console.log(`Usage: ${JSON.stringify(data.usage || {})}`);
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
};

// Run test
testAzureOpenAI();
