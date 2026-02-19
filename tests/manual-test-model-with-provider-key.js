/**
 * Manual Test: Model Testing with Provider-Specific API Key
 *
 * This test validates that the model test endpoint works correctly when:
 * 1. A provider-specific API key is configured in providers.json
 * 2. The model itself doesn't have an API key configured
 *
 * To run this test:
 * 1. Set a provider API key in contents/config/providers.json
 * 2. Ensure the model doesn't have its own API key
 * 3. Run: node tests/manual-test-model-with-provider-key.js
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

async function testModelWithProviderKey() {
  console.log('🧪 Testing Model Test Endpoint with Provider-Specific API Key\n');

  try {
    // 1. Import required modules
    const { simpleCompletion } = await import('../server/utils.js');
    const { default: tokenStorageService } =
      await import('../server/services/TokenStorageService.js');

    // 2. Read providers.json to check for provider-specific keys
    const providersPath = join(rootDir, 'contents', 'config', 'providers.json');
    const providersData = JSON.parse(await fs.readFile(providersPath, 'utf8'));

    console.log('📋 Current Providers Configuration:');
    for (const provider of providersData.providers || []) {
      const hasKey = provider.apiKey ? '✅ Has API Key' : '❌ No API Key';
      console.log(`   - ${provider.id}: ${hasKey}`);
      if (provider.apiKey) {
        console.log(`     (Key is encrypted: ${tokenStorageService.isEncrypted(provider.apiKey)})`);
      }
    }
    console.log('');

    // 3. Test simpleCompletion with a Google model (if provider key exists)
    const googleProvider = providersData.providers?.find(p => p.id === 'google');

    if (googleProvider && googleProvider.apiKey) {
      console.log('✅ Found Google provider with API key');
      console.log('🔑 Testing simpleCompletion with provider-specific key...\n');

      // Decrypt the key for testing
      let decryptedKey;
      if (tokenStorageService.isEncrypted(googleProvider.apiKey)) {
        decryptedKey = tokenStorageService.decryptString(googleProvider.apiKey);
        console.log('   Decrypted provider API key for testing');
      } else {
        decryptedKey = googleProvider.apiKey;
        console.log('   Using plaintext provider API key');
      }

      // Test 1: simpleCompletion with explicit API key (existing behavior)
      console.log('\n📝 Test 1: simpleCompletion with explicit API key');
      try {
        const result1 = await simpleCompletion('Say "test1 successful"', {
          modelId: 'gemini-2.5-flash',
          apiKey: decryptedKey
        });
        console.log('   ✅ Test 1 PASSED: Explicit API key works');
        console.log(`   Response: ${result1.content.substring(0, 100)}...`);
      } catch (error) {
        console.log(`   ❌ Test 1 FAILED: ${error.message}`);
      }

      // Test 2: simpleCompletion without explicit API key (should use getApiKeyForModel)
      console.log(
        '\n📝 Test 2: simpleCompletion without explicit API key (fallback to getApiKeyForModel)'
      );
      try {
        const result2 = await simpleCompletion('Say "test2 successful"', {
          modelId: 'gemini-2.5-flash'
          // No apiKey provided - should fallback to getApiKeyForModel
        });
        console.log('   ✅ Test 2 PASSED: Fallback to provider key works');
        console.log(`   Response: ${result2.content.substring(0, 100)}...`);
      } catch (error) {
        console.log(`   ❌ Test 2 FAILED: ${error.message}`);
      }
    } else {
      console.log('⚠️  No Google provider with API key found');
      console.log('   To test this functionality:');
      console.log('   1. Add a Google API key to contents/config/providers.json');
      console.log('   2. Run this test again');
    }

    console.log('\n✅ Test completed\n');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testModelWithProviderKey();
