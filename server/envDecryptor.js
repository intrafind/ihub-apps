/**
 * Early environment variable decryption
 * This module decrypts encrypted environment variables before any other module loads.
 * It must be imported before any other server modules to ensure encrypted values are decrypted.
 *
 * Uses TokenStorageService for encryption/decryption to avoid code duplication.
 * Encrypted values use the format: ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
 */

// We need to initialize TokenStorageService early, but avoid circular dependencies
// by importing it dynamically after dotenv has loaded
import crypto from 'crypto';

/**
 * Check if TOKEN_ENCRYPTION_KEY is set and valid for production
 */
function validateEncryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!key) {
    // In production, fail fast
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY is required in production. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }

    // In development, warn about using a temporary key
    console.warn('');
    console.warn('⚠️  SECURITY WARNING: TOKEN_ENCRYPTION_KEY not set!');
    console.warn('   A temporary key will be generated, but it will NOT persist across restarts.');
    console.warn('   Encrypted values from previous runs CANNOT be decrypted with a new key.');
    console.warn('');
    console.warn('   For persistent encryption, set TOKEN_ENCRYPTION_KEY in your .env file:');
    console.warn(
      '   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    console.warn('');

    // Set a temporary key for this session
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  }
}

/**
 * Process all environment variables and decrypt encrypted ones
 * Uses TokenStorageService which is already available in the codebase
 */
async function decryptEnvironmentVariables() {
  // Validate encryption key first
  validateEncryptionKey();

  // Import TokenStorageService dynamically to avoid circular dependencies
  const { default: tokenStorageService } = await import('./services/TokenStorageService.js');

  let decryptedCount = 0;
  const failedVars = [];

  // Control verbosity - can be disabled in production
  const verbose = process.env.NODE_ENV !== 'production';

  Object.keys(process.env).forEach(key => {
    const value = process.env[key];

    if (tokenStorageService.isEncrypted(value)) {
      try {
        const decrypted = tokenStorageService.decryptString(value);
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
await decryptEnvironmentVariables();

// No exports needed - this module just decrypts environment variables
