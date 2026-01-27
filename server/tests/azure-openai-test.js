import dotenv from 'dotenv';
import { createCompletionRequest } from '../adapters/index.js';
import logger from '../utils/logger.js';

// Load environment variables
dotenv.config({ path: '../.env' });

logger.info('🔧 Azure OpenAI Configuration Test\n');

// Test Azure OpenAI configuration
const testAzureOpenAI = async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;

  if (!apiKey || !baseUrl) {
    logger.info('❌ Missing OPENAI_API_KEY or OPENAI_BASE_URL');
    return;
  }

  logger.info('Configuration:');
  logger.info(`Base URL: ${baseUrl}`);
  logger.info(`API Key: ${apiKey.substring(0, 20)}...`);
  logger.info(`Is Azure: ${baseUrl.includes('azure.com') ? 'Yes' : 'No'}`);

  const model = {
    modelId: 'gpt-4o-mini', // This should be ignored for Azure - Azure uses deployment name from URL
    url: baseUrl,
    provider: 'openai'
  };

  const messages = [
    { role: 'user', content: 'Say hello and explain what you are in one sentence.' }
  ];

  try {
    logger.info('\n🔄 Creating request...');
    const request = createCompletionRequest(model, messages, apiKey, {
      temperature: 0.1,
      maxTokens: 100,
      stream: false // Disable streaming for simple test
    });

    logger.info('Request created successfully:');
    logger.info(`URL: ${request.url}`);
    logger.info(`Method: ${request.method}`);
    logger.info(`Headers: ${JSON.stringify(request.headers, null, 2)}`);
    logger.info(`Body: ${JSON.stringify(request.body, null, 2)}`);

    logger.info('\n🔄 Making API call...');

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

    logger.info(`Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      logger.info(`Error response: ${errorText}`);
      return;
    }

    const data = await response.json();
    logger.info('\n✅ Response received:');
    logger.info(`Content: "${data.choices?.[0]?.message?.content || 'No content'}"`);
    logger.info(`Model: ${data.model || 'Unknown'}`);
    logger.info(`Usage: ${JSON.stringify(data.usage || {})}`);
  } catch (error) {
    logger.info(`❌ Error: ${error.message}`);
  }
};

// Run test
testAzureOpenAI();
