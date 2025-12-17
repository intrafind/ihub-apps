#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'crypto';

/**
 * CLI tool to encrypt values for use in .env files
 * Usage: node server/utils/encryptEnvValue.js "your-password-here"
 *
 * Uses TokenStorageService for consistency with the rest of the application.
 */

// Ensure TOKEN_ENCRYPTION_KEY is set
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  console.warn('⚠️  TOKEN_ENCRYPTION_KEY not set. Generating a temporary key...');
  console.warn('   Set TOKEN_ENCRYPTION_KEY in your .env file for persistent encryption.');
  console.warn('');
  const tempKey = crypto.randomBytes(32).toString('hex');
  process.env.TOKEN_ENCRYPTION_KEY = tempKey;
  console.log('Generated key for this session:');
  console.log(`TOKEN_ENCRYPTION_KEY=${tempKey}`);
  console.log('');
}

// Import TokenStorageService to use its encryption method
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');

const value = process.argv[2];

if (!value) {
  console.error('Usage: node server/utils/encryptEnvValue.js "value-to-encrypt"');
  console.error('');
  console.error('Example:');
  console.error('  node server/utils/encryptEnvValue.js "my-secret-password"');
  console.error('');
  console.error('The encrypted value can be used directly in your .env file.');
  process.exit(1);
}

try {
  const encrypted = tokenStorageService.encryptString(value);
  console.log('');
  console.log('✅ Encrypted value:');
  console.log('');
  console.log(encrypted);
  console.log('');
  console.log('💡 Examples of adding this to your .env file:');
  console.log(`# For LDAP password:`);
  console.log(`LDAP_ADMIN_PASSWORD=${encrypted}`);
  console.log(`# For API keys:`);
  console.log(`OPENAI_API_KEY=${encrypted}`);
  console.log(`# For any sensitive value:`);
  console.log(`YOUR_VARIABLE_NAME=${encrypted}`);
  console.log('');
  console.log('⚠️  Keep the TOKEN_ENCRYPTION_KEY consistent! If you change it,');
  console.log('   you will need to re-encrypt all encrypted values.');
  console.log('');
} catch (error) {
  console.error('❌ Encryption failed:', error.message);
  process.exit(1);
}
