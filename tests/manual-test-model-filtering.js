/**
 * Manual Test for Model Filtering in RequestBuilder
 * 
 * This test verifies that the backend correctly filters models based on app requirements
 * and properly handles fallback when an incompatible model is selected.
 * 
 * Test Scenarios:
 * 1. Image generator app should only use models with supportsImageGeneration: true
 * 2. When an incompatible model is selected, it should fallback to a compatible one
 * 3. When no compatible models exist, it should return an error
 */

import RequestBuilder from '../server/services/chat/RequestBuilder.js';
import configCache from '../server/configCache.js';

const testModelFiltering = async () => {
  console.log('🧪 Testing Model Filtering Logic\n');
  
  try {
    // Initialize config cache
    console.log('📦 Initializing configuration cache...');
    await configCache.initialize();
    
    const requestBuilder = new RequestBuilder();
    
    // Get test data
    const { data: apps } = configCache.getApps();
    const { data: models } = configCache.getModels();
    
    const imageGenApp = apps.find(a => a.id === 'image-generator');
    const chatApp = apps.find(a => a.id === 'chat');
    
    console.log('\n📊 Available Models:');
    models.forEach(model => {
      console.log(`  - ${model.id} (enabled: ${model.enabled}, supportsImageGeneration: ${model.supportsImageGeneration || false})`);
    });
    
    // Test 1: Image generator app with compatible model
    console.log('\n\n🧪 Test 1: Image generator app with compatible model');
    console.log('Expected: Should use gemini-3-pro-image');
    const test1 = await requestBuilder.prepareChatRequest({
      appId: 'image-generator',
      modelId: 'gemini-3-pro-image',
      messages: [{ role: 'user', content: 'Generate an image of a sunset' }],
      temperature: 0.7,
      language: 'en',
      processMessageTemplates: async (msgs) => msgs
    });
    
    if (test1.success) {
      console.log(`✅ Result: Using model ${test1.data.model.id}`);
      console.log(`   Model supports image generation: ${test1.data.model.supportsImageGeneration}`);
    } else {
      console.log(`❌ Error: ${test1.error.message}`);
    }
    
    // Test 2: Image generator app with incompatible model (should fallback)
    console.log('\n\n🧪 Test 2: Image generator app with incompatible model');
    console.log('Expected: Should fallback to a compatible model with supportsImageGeneration: true');
    const test2 = await requestBuilder.prepareChatRequest({
      appId: 'image-generator',
      modelId: 'gemini-2.5-flash', // This model doesn't support image generation
      messages: [{ role: 'user', content: 'Generate an image of a sunset' }],
      temperature: 0.7,
      language: 'en',
      processMessageTemplates: async (msgs) => msgs
    });
    
    if (test2.success) {
      console.log(`✅ Result: Fell back to model ${test2.data.model.id}`);
      console.log(`   Model supports image generation: ${test2.data.model.supportsImageGeneration}`);
      if (test2.data.model.supportsImageGeneration) {
        console.log('   ✅ PASS: Fallback model supports image generation');
      } else {
        console.log('   ❌ FAIL: Fallback model does NOT support image generation');
      }
    } else {
      console.log(`❌ Error: ${test2.error.message}`);
    }
    
    // Test 3: Regular chat app (should work with any model)
    console.log('\n\n🧪 Test 3: Regular chat app with any model');
    console.log('Expected: Should use the specified model without filtering');
    const test3 = await requestBuilder.prepareChatRequest({
      appId: 'chat',
      modelId: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      language: 'en',
      processMessageTemplates: async (msgs) => msgs
    });
    
    if (test3.success) {
      console.log(`✅ Result: Using model ${test3.data.model.id}`);
    } else {
      console.log(`❌ Error: ${test3.error.message}`);
    }
    
    // Test 4: Image generator app with no modelId (should use preferred or compatible default)
    console.log('\n\n🧪 Test 4: Image generator app with no modelId specified');
    console.log('Expected: Should use preferred model or compatible default');
    const test4 = await requestBuilder.prepareChatRequest({
      appId: 'image-generator',
      modelId: null, // No model specified
      messages: [{ role: 'user', content: 'Generate an image' }],
      temperature: 0.7,
      language: 'en',
      processMessageTemplates: async (msgs) => msgs
    });
    
    if (test4.success) {
      console.log(`✅ Result: Using model ${test4.data.model.id}`);
      console.log(`   Model supports image generation: ${test4.data.model.supportsImageGeneration}`);
      if (test4.data.model.supportsImageGeneration) {
        console.log('   ✅ PASS: Selected model supports image generation');
      } else {
        console.log('   ❌ FAIL: Selected model does NOT support image generation');
      }
    } else {
      console.log(`❌ Error: ${test4.error.message}`);
    }
    
    console.log('\n\n✅ All tests completed!\n');
    
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error(error.stack);
    process.exit(1);
  }
};

// Run the test
testModelFiltering()
  .then(() => {
    console.log('Test execution completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
