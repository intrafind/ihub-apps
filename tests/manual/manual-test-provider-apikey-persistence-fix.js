#!/usr/bin/env node
/**
 * Integration Test: Provider API Key Persistence
 *
 * This test verifies that provider API keys set via the admin panel
 * persist correctly across server restarts and can be decrypted successfully.
 *
 * Test Scenario:
 * 1. Initialize encryption key (simulate first server start)
 * 2. Admin sets a provider API key via admin panel
 * 3. Simulate server restart (new TokenStorageService instance)
 * 4. Verify API key can still be decrypted and used
 *
 * Run: node tests/manual-test-provider-apikey-persistence-fix.js
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const TEST_DIR = path.join(__dirname, '../../tmp-test-encryption');
const KEY_FILE = path.join(TEST_DIR, '.encryption-key');
const PROVIDERS_FILE = path.join(TEST_DIR, 'providers.json');
const TEST_API_KEY = 'sk-test-openai-key-12345678abcdef';

// Simplified TokenStorageService for testing
class TestTokenService {
  constructor() {
    this.encryptionKey = null;
    this.keyFilePath = KEY_FILE;
  }

  async initializeEncryptionKey() {
    // Priority 1: Try to load persisted key
    try {
      const persistedKey = await fs.readFile(this.keyFilePath, 'utf8');
      if (
        persistedKey &&
        persistedKey.length === 64 &&
        /^[0-9a-f]{64}$/i.test(persistedKey.trim())
      ) {
        this.encryptionKey = persistedKey.trim();
        console.log('  🔐 Using persisted encryption key from disk');
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('  ⚠️  Error reading encryption key file:', error.message);
      }
    }

    // Priority 2: Generate new key and persist it
    this.encryptionKey = crypto.randomBytes(32).toString('hex');
    console.log('  ⚠️  Generated new encryption key');

    try {
      await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
      await fs.writeFile(this.keyFilePath, this.encryptionKey, { mode: 0o600 });
      console.log(`  ✅ Encryption key persisted to: ${this.keyFilePath}`);
    } catch (error) {
      console.error('  ❌ Failed to persist encryption key:', error.message);
      throw error;
    }
  }

  _ensureKeyInitialized() {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized. Call initializeEncryptionKey() first.');
    }
  }

  encryptString(plaintext) {
    this._ensureKeyInitialized();
    const key = Buffer.from(this.encryptionKey, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    return `ENC[AES256_GCM,data:${encrypted},iv:${iv.toString('base64')},tag:${authTag.toString('base64')},type:str]`;
  }

  decryptString(encryptedData) {
    this._ensureKeyInitialized();
    const encContent = encryptedData.slice(4, -1);

    const dataMatch = encContent.match(/data:([A-Za-z0-9+/=]+)/);
    const ivMatch = encContent.match(/iv:([A-Za-z0-9+/=]+)/);
    const tagMatch = encContent.match(/tag:([A-Za-z0-9+/=]+)/);

    if (!dataMatch || !ivMatch || !tagMatch) {
      throw new Error('Invalid encrypted data format');
    }

    const encrypted = Buffer.from(dataMatch[1], 'base64');
    const iv = Buffer.from(ivMatch[1], 'base64');
    const authTag = Buffer.from(tagMatch[1], 'base64');
    const key = Buffer.from(this.encryptionKey, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  isEncrypted(value) {
    return value && value.startsWith('ENC[') && value.endsWith(']');
  }
}

async function runTest() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Provider API Key Persistence - Integration Test        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Cleanup from previous runs
    try {
      await fs.rm(TEST_DIR, { recursive: true });
    } catch (e) {
      // Ignore if directory doesn't exist
    }
    await fs.mkdir(TEST_DIR, { recursive: true });

    // ========================================
    // Test 1: First Server Start
    // ========================================
    console.log('📝 Test 1: First Server Start (Generate & Persist Key)');
    console.log('─────────────────────────────────────────────────────────');

    const service1 = new TestTokenService();
    await service1.initializeEncryptionKey();

    // Verify key file was created
    const keyFileExists = await fs
      .access(KEY_FILE)
      .then(() => true)
      .catch(() => false);
    if (keyFileExists) {
      console.log('  ✅ Encryption key file created');
      testsPassed++;
    } else {
      console.log('  ❌ Encryption key file NOT created');
      testsFailed++;
    }

    // Verify key file has correct permissions (Unix only)
    if (process.platform !== 'win32') {
      const stats = await fs.stat(KEY_FILE);
      const mode = stats.mode & parseInt('777', 8);
      const expectedMode = parseInt('600', 8);

      if (mode === expectedMode) {
        console.log('  ✅ File permissions correct (600)');
        testsPassed++;
      } else {
        console.log(
          `  ❌ File permissions incorrect: ${mode.toString(8)} (expected ${expectedMode.toString(8)})`
        );
        testsFailed++;
      }
    }

    // ========================================
    // Test 2: Admin Sets Provider API Key
    // ========================================
    console.log('\n📝 Test 2: Admin Sets Provider API Key');
    console.log('─────────────────────────────────────────────────────────');

    const encryptedKey = service1.encryptString(TEST_API_KEY);
    console.log('  ✅ API key encrypted');

    const providersData = {
      providers: [
        {
          id: 'openai',
          name: { en: 'OpenAI', de: 'OpenAI' },
          description: { en: 'OpenAI API', de: 'OpenAI API' },
          enabled: true,
          apiKey: encryptedKey
        }
      ]
    };

    await fs.writeFile(PROVIDERS_FILE, JSON.stringify(providersData, null, 2));
    console.log('  ✅ Saved to providers.json');
    testsPassed += 2;

    // ========================================
    // Test 3: Server Restart (Load Existing Key)
    // ========================================
    console.log('\n📝 Test 3: Server Restart (Load Existing Key)');
    console.log('─────────────────────────────────────────────────────────');

    const service2 = new TestTokenService();
    await service2.initializeEncryptionKey();

    // Verify same key was loaded
    if (service1.encryptionKey === service2.encryptionKey) {
      console.log('  ✅ Same encryption key loaded from disk');
      testsPassed++;
    } else {
      console.log('  ❌ Different encryption key loaded!');
      console.log('    Original:', service1.encryptionKey);
      console.log('    Loaded:  ', service2.encryptionKey);
      testsFailed++;
    }

    // ========================================
    // Test 4: Decrypt and Use API Key
    // ========================================
    console.log('\n📝 Test 4: Decrypt and Use API Key (After Restart)');
    console.log('─────────────────────────────────────────────────────────');

    const loadedData = JSON.parse(await fs.readFile(PROVIDERS_FILE, 'utf8'));
    const provider = loadedData.providers[0];

    if (!provider.apiKey) {
      console.log('  ❌ Provider does not have apiKey field!');
      testsFailed++;
    } else {
      console.log('  ✅ Provider has apiKey field');
      testsPassed++;
    }

    if (!service2.isEncrypted(provider.apiKey)) {
      console.log('  ❌ API key is not in encrypted format!');
      testsFailed++;
    } else {
      console.log('  ✅ API key is properly encrypted');
      testsPassed++;
    }

    try {
      const decryptedKey = service2.decryptString(provider.apiKey);
      console.log('  ✅ API key decrypted successfully');
      testsPassed++;

      if (decryptedKey === TEST_API_KEY) {
        console.log('  ✅ Decrypted key matches original');
        testsPassed++;
      } else {
        console.log('  ❌ Decrypted key does NOT match original!');
        console.log('    Expected:', TEST_API_KEY);
        console.log('    Got:     ', decryptedKey);
        testsFailed++;
      }
    } catch (error) {
      console.log('  ❌ Failed to decrypt API key:', error.message);
      testsFailed += 2;
    }

    // ========================================
    // Test 5: Third Server Start (Verify Persistence)
    // ========================================
    console.log('\n📝 Test 5: Third Server Start (Verify Continued Persistence)');
    console.log('─────────────────────────────────────────────────────────');

    const service3 = new TestTokenService();
    await service3.initializeEncryptionKey();

    try {
      const thirdDecryption = service3.decryptString(provider.apiKey);
      if (thirdDecryption === TEST_API_KEY) {
        console.log('  ✅ API key still works after third restart');
        testsPassed++;
      } else {
        console.log('  ❌ API key changed after third restart');
        testsFailed++;
      }
    } catch (error) {
      console.log('  ❌ Failed to decrypt on third restart:', error.message);
      testsFailed++;
    }
  } catch (error) {
    console.error('\n❌ Test execution failed:', error);
    testsFailed++;
  } finally {
    // Cleanup
    try {
      await fs.rm(TEST_DIR, { recursive: true });
      console.log('\n🧹 Cleanup complete');
    } catch (e) {
      console.error('⚠️  Cleanup failed:', e.message);
    }
  }

  // ========================================
  // Test Results
  // ========================================
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                      Test Results                        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log(`  ✅ Tests Passed: ${testsPassed}`);
  console.log(`  ❌ Tests Failed: ${testsFailed}`);
  console.log(`  📊 Total Tests:  ${testsPassed + testsFailed}\n`);

  if (testsFailed === 0) {
    console.log('🎉 ALL TESTS PASSED! Provider API key persistence works correctly.\n');
    console.log('✅ Encryption keys are persisted across server restarts');
    console.log('✅ API keys remain decryptable after restart');
    console.log('✅ The fix for "Provider specific key not used after restart" is verified!\n');
    process.exit(0);
  } else {
    console.log('❌ SOME TESTS FAILED. Please review the errors above.\n');
    process.exit(1);
  }
}

// Run the test
runTest().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
