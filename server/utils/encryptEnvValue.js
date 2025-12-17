#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'crypto';

/**
 * CLI tool to encrypt values for use in .env files
 * Usage: node server/utils/encryptEnvValue.js "your-password-here"
 */

/**
 * Get encryption key from environment
 */
function getEncryptionKey() {
  let key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!key) {
    // Generate a random key if not provided (development only)
    key = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️  Using generated encryption key. Set TOKEN_ENCRYPTION_KEY for production.');
  }

  return Buffer.from(key, 'hex');
}

/**
 * Encrypt a string value
 */
function encryptString(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Invalid plaintext: must be a non-empty string');
  }

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);

    // Use AES-256-GCM for authenticated encryption
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // Get the authentication tag
    const authTag = cipher.getAuthTag();

    // Format: ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
    const encryptedValue = `ENC[AES256_GCM,data:${encrypted},iv:${iv.toString('base64')},tag:${authTag.toString('base64')},type:str]`;

    return encryptedValue;
  } catch (error) {
    throw new Error(`Failed to encrypt string: ${error.message}`);
  }
}

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
  const encrypted = encryptString(value);
  console.log('');
  console.log('✅ Encrypted value:');
  console.log('');
  console.log(encrypted);
  console.log('');
  console.log('💡 Add this to your .env file:');
  console.log(`LDAP_ADMIN_PASSWORD=${encrypted}`);
  console.log('');
  console.log('⚠️  Keep the TOKEN_ENCRYPTION_KEY consistent! If you change it,');
  console.log('   you will need to re-encrypt all encrypted values.');
  console.log('');
} catch (error) {
  console.error('❌ Encryption failed:', error.message);
  process.exit(1);
}
