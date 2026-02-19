#!/usr/bin/env node
import 'dotenv/config';
import './envDecryptor.js';

/**
 * Test script to verify environment variable decryption
 * Usage:
 * 1. Add encrypted values to .env file
 * 2. Run: node server/utils/testEnvDecryption.js
 */

console.log('');
console.log('🧪 Testing Environment Variable Decryption');
console.log('='.repeat(50));
console.log('');

// Test a few common environment variables
const testVars = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'LDAP_ADMIN_PASSWORD',
  'AD_BIND_PASSWORD',
  'JWT_SECRET',
  'TOKEN_ENCRYPTION_KEY'
];

let foundEncrypted = false;

testVars.forEach(varName => {
  const value = process.env[varName];
  if (value) {
    // Check if it looks encrypted (would not be after decryption)
    const isStillEncrypted = value.startsWith('ENC[');
    const status = isStillEncrypted ? '❌ STILL ENCRYPTED' : '✅ Decrypted/Plain';

    if (isStillEncrypted) {
      foundEncrypted = true;
      console.log(`${varName}: ${status}`);
      console.log(`  Value: ${value.substring(0, 50)}...`);
    } else {
      console.log(`${varName}: ${status}`);
      // Only show that a value exists, not its content
      console.log(`  Value: ${'*'.repeat(Math.min(value.length, 20))} (${value.length} chars)`);
    }
  } else {
    console.log(`${varName}: ⚪ Not set`);
  }
  console.log('');
});

if (foundEncrypted) {
  console.log('⚠️  Some variables are still encrypted - decryption may have failed!');
  console.log('   Check that TOKEN_ENCRYPTION_KEY matches the key used for encryption.');
  process.exit(1);
} else {
  console.log('✅ All encrypted variables were successfully decrypted (or none were encrypted)');
  process.exit(0);
}
