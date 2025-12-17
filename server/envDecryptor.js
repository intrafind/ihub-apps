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
 * In production, this must be explicitly set. In development, a warning is shown.
 */
function getEncryptionKey() {
  let key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!key) {
    // In production, fail fast rather than generating a random key
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY is required in production. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }

    // In development, generate a random key but warn loudly
    key = crypto.randomBytes(32).toString('hex');
    console.warn('');
    console.warn('⚠️  SECURITY WARNING: Using a randomly generated encryption key!');
    console.warn('   This is ONLY acceptable for local development/testing.');
    console.warn('   Generated keys are NOT persistent - they change on every restart.');
    console.warn('   This means encrypted values from previous runs CANNOT be decrypted.');
    console.warn('');
    console.warn('   For production or persistent encryption, set TOKEN_ENCRYPTION_KEY:');
    console.warn(
      '   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    console.warn('');
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

// Define regex patterns for encrypted data parsing
const ENCRYPTED_DATA_REGEX = /data:([A-Za-z0-9+/=]+)/;
const ENCRYPTED_IV_REGEX = /iv:([A-Za-z0-9+/=]+)/;
const ENCRYPTED_TAG_REGEX = /tag:([A-Za-z0-9+/=]+)/;

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
    const dataMatch = encContent.match(ENCRYPTED_DATA_REGEX);
    const ivMatch = encContent.match(ENCRYPTED_IV_REGEX);
    const tagMatch = encContent.match(ENCRYPTED_TAG_REGEX);

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
  const failedVars = [];

  // Control verbosity - can be disabled in production
  const verbose = process.env.NODE_ENV !== 'production';

  Object.keys(process.env).forEach(key => {
    const value = process.env[key];

    if (isEncrypted(value)) {
      try {
        const decrypted = decryptString(value);
        process.env[key] = decrypted;
        decryptedCount++;
        if (verbose) {
          console.log(`🔓 Decrypted environment variable: ${key}`);
        }
      } catch (error) {
        failedVars.push({ key, error: error.message });
        console.error(
          `⚠️  Failed to decrypt environment variable ${key}. This usually means TOKEN_ENCRYPTION_KEY has changed or the value is corrupted.`
        );
        console.error(`   Error: ${error.message}`);
        // Leave the encrypted value as-is - application should handle gracefully or fail during authentication
      }
    }
  });

  if (decryptedCount > 0) {
    console.log(`✅ Decrypted ${decryptedCount} environment variable(s)`);
  }

  // If any decryptions failed, provide a summary
  if (failedVars.length > 0) {
    console.error('');
    console.error('❌ Decryption failed for the following variables:');
    failedVars.forEach(({ key, error }) => {
      console.error(`   - ${key}: ${error}`);
    });
    console.error('');
    console.error('⚠️  The application may fail when trying to use these encrypted values.');
    console.error('   Please verify TOKEN_ENCRYPTION_KEY and re-encrypt if necessary.');
    console.error('');
  }
}

// Run decryption immediately when this module is imported
decryptEnvironmentVariables();

// Export for testing purposes
export { isEncrypted, decryptString, decryptEnvironmentVariables };
