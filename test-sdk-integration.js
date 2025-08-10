#!/usr/bin/env node

/**
 * Test script to validate SDK integration with the server
 *
 * Usage:
 * export USE_LLM_SDK=true
 * export OPENAI_API_KEY=your_key_here
 * node test-sdk-integration.js
 */

import configCache from './server/configCache.js';
import { getSDKClient } from './server/adapters/index.js';
import { LLMClient } from './llm-sdk/src/core/LLMClient.js';

async function testSDKIntegration() {
  console.log('🧪 Testing SDK Integration...\n');

  try {
    // Test 1: Initialize config cache
    console.log('1️⃣ Initializing config cache...');
    await configCache.initialize();
    console.log('✅ Config cache initialized\n');

    // Test 2: Check if SDK is enabled
    const USE_SDK = process.env.USE_LLM_SDK === 'true';
    console.log(`2️⃣ SDK Mode: ${USE_SDK ? '🚀 ENABLED' : '❌ DISABLED'}`);

    if (!USE_SDK) {
      console.log('💡 To enable SDK, set: export USE_LLM_SDK=true\n');
      return;
    }

    // Test 3: Get SDK client
    console.log('3️⃣ Getting SDK client...');
    const sdkClient = await getSDKClient();

    if (!sdkClient) {
      console.log('❌ Failed to get SDK client');
      return;
    }

    console.log('✅ SDK client obtained');
    console.log(`   Type: ${sdkClient.constructor.name}`);
    console.log(`   Providers: ${sdkClient.getProviders().join(', ')}`);
    console.log();

    // Test 4: Check available models
    console.log('4️⃣ Checking available models...');
    const models = sdkClient.getAvailableModels();
    console.log(`✅ Found ${models.length} models:`);

    const modelsByProvider = {};
    for (const model of models) {
      if (!modelsByProvider[model.provider]) {
        modelsByProvider[model.provider] = [];
      }
      modelsByProvider[model.provider].push(model.id);
    }

    for (const [provider, providerModels] of Object.entries(modelsByProvider)) {
      console.log(`   📊 ${provider}: ${providerModels.length} models`);
    }
    console.log();

    // Test 5: Test simple chat (if OpenAI key is available)
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_key_here') {
      console.log('5️⃣ Testing simple chat...');

      try {
        const response = await sdkClient.chat({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'user', content: 'Say hello and confirm you can respond. Keep it brief.' }
          ],
          maxTokens: 50
        });

        console.log('✅ Chat test successful!');
        console.log(`   Response: "${response.choices[0].message.content.substring(0, 100)}..."`);
        console.log(`   Tokens used: ${response.usage.totalTokens}`);
      } catch (error) {
        console.log(`❌ Chat test failed: ${error.message}`);
      }
    } else {
      console.log('5️⃣ Skipping chat test (no OpenAI API key)');
      console.log('   💡 Set OPENAI_API_KEY to test actual API calls');
    }
    console.log();

    console.log('🎉 SDK Integration Test Complete!');
  } catch (error) {
    console.error('💥 Test failed:', error);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the test
testSDKIntegration()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Test script error:', error);
    process.exit(1);
  });
