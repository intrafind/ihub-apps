import crypto from 'crypto';

/**
 * Early environment variable decryption
 * This module decrypts encrypted environment variables before any other module loads.
 * It must be imported before any other server modules to ensure encrypted values are decrypted.
 *
 * Encrypted values use the format: ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
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
 * Check if a string appears to be encrypted
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  return value.startsWith('ENC[') && value.endsWith(']');
}

/**
 * Decrypt an encrypted string
 */
function decryptString(encryptedData) {
  if (!encryptedData || typeof encryptedData !== 'string') {
    throw new Error('Invalid encrypted data: must be a non-empty string');
  }

  try {
    // Parse ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
    const encContent = encryptedData.slice(4, -1); // Remove "ENC[" and "]"

    // Extract algorithm
    const algorithmMatch = encContent.match(/^([^,]+)/);
    if (!algorithmMatch || algorithmMatch[1] !== 'AES256_GCM') {
      throw new Error(`Unsupported or missing encryption algorithm`);
    }

    // Extract data, iv, and tag using regex patterns
    const dataMatch = encContent.match(/data:([A-Za-z0-9+/=]+)/);
    const ivMatch = encContent.match(/iv:([A-Za-z0-9+/=]+)/);
    const tagMatch = encContent.match(/tag:([A-Za-z0-9+/=]+)/);

    if (!dataMatch || !ivMatch || !tagMatch) {
      throw new Error('Invalid ENC format: missing required fields');
    }

    const encrypted = Buffer.from(dataMatch[1], 'base64');
    const iv = Buffer.from(ivMatch[1], 'base64');
    const authTag = Buffer.from(tagMatch[1], 'base64');

    const key = getEncryptionKey();

    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt the data
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error(`Failed to decrypt string: ${error.message}`);
  }
}

/**
 * Process all environment variables and decrypt encrypted ones
 */
function decryptEnvironmentVariables() {
  let decryptedCount = 0;

  Object.keys(process.env).forEach(key => {
    const value = process.env[key];

    if (isEncrypted(value)) {
      try {
        const decrypted = decryptString(value);
        process.env[key] = decrypted;
        decryptedCount++;
        console.log(`🔓 Decrypted environment variable: ${key}`);
      } catch (error) {
        console.error(
          `⚠️  Failed to decrypt environment variable ${key}. This usually means TOKEN_ENCRYPTION_KEY has changed or the value is corrupted.`
        );
        console.error(`   Error: ${error.message}`);
        // Leave the encrypted value as-is
      }
    }
  });

  if (decryptedCount > 0) {
    console.log(`✅ Decrypted ${decryptedCount} environment variable(s)`);
  }
}

// Run decryption immediately when this module is imported
decryptEnvironmentVariables();

// Export for testing purposes
export { isEncrypted, decryptString, decryptEnvironmentVariables };
