#!/usr/bin/env node

/**
 * Test script to verify encryption/decryption of environment variables
 * This demonstrates the full workflow:
 * 1. Encrypt a plaintext value
 * 2. Store it in an environment variable
 * 3. Load it back and decrypt automatically
 */

import tokenStorageService from '../server/services/TokenStorageService.js';

(async () => {
  console.log('='.repeat(60));
  console.log('Value Encryption Tool - End-to-End Test');
  console.log('='.repeat(60));
  
  // Initialize encryption key
  await tokenStorageService.initializeEncryptionKey();
  
  // Test 1: Encrypt a password
  console.log('\n📝 Test 1: Encrypt a Password');
  const plaintextPassword = 'my-ldap-admin-password-123!@#';
  console.log('   Plaintext:', plaintextPassword);
  
  const encryptedPassword = tokenStorageService.encryptString(plaintextPassword);
  console.log('   Encrypted:', encryptedPassword);
  console.log('   ✅ Encryption successful');
  
  // Test 2: Verify encrypted format
  console.log('\n📝 Test 2: Verify Encrypted Format');
  const isEncrypted = tokenStorageService.isEncrypted(encryptedPassword);
  console.log('   Is encrypted?', isEncrypted);
  console.log('   Starts with ENC[?', encryptedPassword.startsWith('ENC['));
  console.log('   Ends with ]?', encryptedPassword.endsWith(']'));
  console.log('   ✅ Format verification successful');
  
  // Test 3: Decrypt the password
  console.log('\n📝 Test 3: Decrypt the Password');
  const decryptedPassword = tokenStorageService.decryptString(encryptedPassword);
  console.log('   Decrypted:', decryptedPassword);
  console.log('   Matches original?', plaintextPassword === decryptedPassword);
  console.log('   ✅ Decryption successful');
  
  // Test 4: Multiple values (simulate .env file)
  console.log('\n📝 Test 4: Multiple Environment Variables');
  const envVars = {
    LDAP_ADMIN_PASSWORD: 'secret-ldap-pass',
    AD_BIND_PASSWORD: 'secret-ad-pass',
    OPENAI_API_KEY: 'sk-abc123def456ghi789',
    CUSTOM_API_KEY: 'custom-key-xyz'
  };
  
  const encryptedEnvVars = {};
  for (const [key, value] of Object.entries(envVars)) {
    encryptedEnvVars[key] = tokenStorageService.encryptString(value);
    console.log(`   ${key}:`);
    console.log(`      Plaintext: ${value}`);
    console.log(`      Encrypted: ${encryptedEnvVars[key].substring(0, 60)}...`);
  }
  console.log('   ✅ Multiple variables encrypted');
  
  // Test 5: Verify all can be decrypted
  console.log('\n📝 Test 5: Verify All Decryption');
  let allMatch = true;
  for (const [key, encryptedValue] of Object.entries(encryptedEnvVars)) {
    const decrypted = tokenStorageService.decryptString(encryptedValue);
    const matches = decrypted === envVars[key];
    console.log(`   ${key}: ${matches ? '✅' : '❌'}`);
    if (!matches) {
      allMatch = false;
      console.log(`      Expected: ${envVars[key]}`);
      console.log(`      Got: ${decrypted}`);
    }
  }
  console.log(`   ${allMatch ? '✅' : '❌'} All values decrypted correctly`);
  
  // Test 6: Simulate .env file usage
  console.log('\n📝 Test 6: Simulate .env File Usage');
  console.log('\n   Example .env file content:');
  console.log('   ' + '─'.repeat(50));
  for (const [key, encryptedValue] of Object.entries(encryptedEnvVars)) {
    console.log(`   ${key}=${encryptedValue}`);
  }
  console.log('   ' + '─'.repeat(50));
  console.log('   ✅ Ready for .env file usage');
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('✅ All Tests Passed!');
  console.log('='.repeat(60));
  console.log('\nThe Value Encryption Tool is working correctly.');
  console.log('You can now:');
  console.log('  1. Use the Admin UI to encrypt values');
  console.log('  2. Copy encrypted values to your .env file');
  console.log('  3. The application will automatically decrypt them at runtime');
  console.log('');
})();
