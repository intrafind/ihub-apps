import crypto from 'crypto';
import config from '../config.js';

/**
 * EncryptionService provides secure encryption and decryption of sensitive data
 * like API keys. It uses AES-256-GCM for encryption with unique IVs per operation.
 */
class EncryptionService {
  constructor() {
    // Get or generate encryption key from environment
    this.encryptionKey = this.getEncryptionKey();
  }

  /**
   * Get or generate the encryption key
   * @returns {Buffer} 32-byte encryption key
   */
  getEncryptionKey() {
    // Use JWT_SECRET as base for encryption key
    // Try process.env first, then config module
    const jwtSecret = process.env.JWT_SECRET || config.JWT_SECRET;

    if (!jwtSecret) {
      console.warn(
        '⚠️  No JWT_SECRET found. Using default encryption key. THIS IS INSECURE FOR PRODUCTION!'
      );
      // Generate a default key (insecure, only for development)
      return crypto.scryptSync('default-insecure-key', 'salt', 32);
    }

    // Derive a 32-byte key from JWT_SECRET using scrypt
    return crypto.scryptSync(jwtSecret, 'api-key-encryption-salt', 32);
  }

  /**
   * Encrypt a plaintext string
   * @param {string} plaintext - The text to encrypt
   * @returns {string} Base64-encoded encrypted data with IV and auth tag
   */
  encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Invalid plaintext: must be a non-empty string');
    }

    // Generate a random initialization vector
    const iv = crypto.randomBytes(16);

    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    // Encrypt the data
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // Get the authentication tag
    const authTag = cipher.getAuthTag();

    // Combine IV, auth tag, and encrypted data
    const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);

    // Return as base64 string
    return combined.toString('base64');
  }

  /**
   * Decrypt an encrypted string
   * @param {string} encryptedData - Base64-encoded encrypted data with IV and auth tag
   * @returns {string} Decrypted plaintext
   */
  decrypt(encryptedData) {
    if (!encryptedData || typeof encryptedData !== 'string') {
      throw new Error('Invalid encrypted data: must be a non-empty string');
    }

    try {
      // Decode from base64
      const combined = Buffer.from(encryptedData, 'base64');

      // Extract IV (first 16 bytes)
      const iv = combined.subarray(0, 16);

      // Extract auth tag (next 16 bytes)
      const authTag = combined.subarray(16, 32);

      // Extract encrypted data (remaining bytes)
      const encrypted = combined.subarray(32);

      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt the data
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('Decryption failed:', error.message);
      throw new Error('Failed to decrypt data. The encryption key may have changed.');
    }
  }

  /**
   * Check if a string appears to be encrypted
   * @param {string} value - The value to check
   * @returns {boolean} True if the value appears to be encrypted
   */
  isEncrypted(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    // Encrypted values are base64 strings of at least 32 bytes (IV + auth tag)
    // which is 44 characters in base64
    if (value.length < 44) {
      return false;
    }

    // Check if it's valid base64 (allow 0-2 padding characters)
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    return base64Regex.test(value);
  }
}

// Create singleton instance
const encryptionService = new EncryptionService();

export default encryptionService;
