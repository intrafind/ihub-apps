import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

/**
 * Centralized Token Storage Service
 * Provides secure encryption, decryption, storage, and retrieval of user tokens
 * for any integration service with user and service-specific security
 */
class TokenStorageService {
  constructor() {
    // Initialize encryption key from environment or persistent storage
    this.encryptionKey = null;
    this.keyFilePath = path.join(getRootDir(), config.CONTENTS_DIR, '.encryption-key');
    this.algorithm = 'aes-256-gcm';
    this.storageBasePath = path.join(getRootDir(), config.CONTENTS_DIR, 'integrations');
  }

  /**
   * Initialize the encryption key
   * This MUST be called before any encryption/decryption operations
   * Priority:
   * 1. Use TOKEN_ENCRYPTION_KEY from environment if set
   * 2. Use persisted key from disk if exists
   * 3. Generate new key and persist it
   */
  async initializeEncryptionKey() {
    // Priority 1: Environment variable (allows override)
    if (process.env.TOKEN_ENCRYPTION_KEY) {
      this.encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
      console.log('🔐 Using encryption key from TOKEN_ENCRYPTION_KEY environment variable');
      return;
    }

    // Priority 2: Try to load persisted key
    try {
      const persistedKey = await fs.readFile(this.keyFilePath, 'utf8');
      if (persistedKey && persistedKey.length === 64) {
        // Validate it's a valid hex string
        if (/^[0-9a-f]{64}$/i.test(persistedKey.trim())) {
          this.encryptionKey = persistedKey.trim();
          console.log('🔐 Using persisted encryption key from disk');
          return;
        } else {
          console.warn('⚠️  Persisted encryption key has invalid format, generating new key');
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error reading encryption key file:', error.message);
      }
      // File doesn't exist or error reading, will generate new key
    }

    // Priority 3: Generate new key and persist it
    this.encryptionKey = crypto.randomBytes(32).toString('hex');
    console.warn(
      '⚠️  Generated new encryption key. This will be persisted to maintain API key compatibility across restarts.'
    );

    try {
      // Ensure contents directory exists
      const contentsDir = path.dirname(this.keyFilePath);
      await fs.mkdir(contentsDir, { recursive: true });

      // Save the key with restrictive permissions
      await fs.writeFile(this.keyFilePath, this.encryptionKey, {
        mode: 0o600 // Read/write for owner only
      });
      console.log(`✅ Encryption key persisted to: ${this.keyFilePath}`);
      console.log(
        '⚠️  IMPORTANT: Keep this file secure and back it up. Losing it will make encrypted API keys unrecoverable.'
      );
    } catch (error) {
      console.error('❌ Failed to persist encryption key:', error.message);
      console.warn('⚠️  Encryption key is not persisted. API keys will be lost on server restart!');
    }
  }

  /**
   * Ensure encryption key is initialized
   * @private
   */
  _ensureKeyInitialized() {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized. Call initializeEncryptionKey() first.');
    }
  }

  /**
   * Generate a unique encryption context for user + service combination
   * This prevents tokens from being copied between users or services
   */
  _generateEncryptionContext(userId, serviceName) {
    const context = `${userId}:${serviceName}`;
    return crypto.createHash('sha256').update(context).digest();
  }

  /**
   * Encrypt token data with user and service-specific security
   */
  encryptTokens(tokens, userId, serviceName) {
    this._ensureKeyInitialized();
    try {
      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = crypto.randomBytes(16);
      const context = this._generateEncryptionContext(userId, serviceName);

      // Include context in the encryption to bind tokens to specific user/service
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

      let encrypted = cipher.update(
        JSON.stringify({ ...tokens, context: context.toString('hex') }),
        'utf8',
        'hex'
      );
      encrypted += cipher.final('hex');

      return {
        encrypted,
        iv: iv.toString('hex'),
        userId,
        serviceName,
        contextHash: context.toString('hex')
      };
    } catch (error) {
      console.error('❌ Error encrypting tokens:', error.message);
      throw new Error('Failed to encrypt tokens');
    }
  }

  /**
   * Decrypt token data with user and service verification
   */
  decryptTokens(encryptedData, userId, serviceName) {
    this._ensureKeyInitialized();
    try {
      // Verify the tokens belong to the requesting user and service
      const expectedContext = this._generateEncryptionContext(userId, serviceName);
      const providedContext = Buffer.from(encryptedData.contextHash, 'hex');

      if (!expectedContext.equals(providedContext)) {
        throw new Error('Token access denied: user/service mismatch');
      }

      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = Buffer.from(encryptedData.iv, 'hex');

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const parsedData = JSON.parse(decrypted);

      // Verify the context matches
      if (parsedData.context !== expectedContext.toString('hex')) {
        throw new Error('Token access denied: context verification failed');
      }

      // Remove context from returned data
      delete parsedData.context;
      return parsedData;
    } catch (error) {
      console.error('❌ Error decrypting tokens:', error.message);
      throw new Error('Failed to decrypt tokens');
    }
  }

  /**
   * Store encrypted user tokens for a specific service
   */
  async storeUserTokens(userId, serviceName, tokens) {
    try {
      const encryptedTokens = this.encryptTokens(tokens, userId, serviceName);
      const now = new Date();
      const tokenData = {
        ...encryptedTokens,
        createdAt: now.toISOString(),
        expiresAt: tokens.expiresIn
          ? new Date(now.getTime() + tokens.expiresIn * 1000).toISOString()
          : null
      };

      // Store in contents/integrations/{service} directory
      const tokenDir = path.join(this.storageBasePath, serviceName);
      await fs.mkdir(tokenDir, { recursive: true });

      const tokenFile = path.join(tokenDir, `${userId}.json`);
      await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));

      console.log(`✅ ${serviceName} tokens stored for user ${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Error storing user tokens:', error.message);
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Retrieve and decrypt user tokens for a specific service
   */
  async getUserTokens(userId, serviceName) {
    try {
      const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      return this.decryptTokens(tokenData, userId, serviceName);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`User not authenticated with ${serviceName}`);
      }
      console.error('❌ Error retrieving user tokens:', error.message);
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Check if tokens are expired based on stored expiration time
   * Includes a 2-minute buffer for proactive refresh
   */
  async areTokensExpired(userId, serviceName) {
    try {
      const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      if (!tokenData.expiresAt) {
        return false; // No expiration set
      }

      const expiresAt = new Date(tokenData.expiresAt);
      const now = new Date();

      // Add 2-minute buffer for proactive refresh before tokens actually expire
      const bufferTime = 2 * 60 * 1000; // 2 minutes in milliseconds
      const expirationWithBuffer = new Date(expiresAt.getTime() - bufferTime);

      const isExpired = expirationWithBuffer <= now;

      return isExpired;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true; // No tokens means expired
      }
      throw error;
    }
  }

  /**
   * Delete user tokens for a specific service (disconnect)
   */
  async deleteUserTokens(userId, serviceName) {
    try {
      const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);
      await fs.unlink(tokenFile);
      console.log(`✅ ${serviceName} tokens deleted for user ${userId}`);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('❌ Error deleting user tokens:', error.message);
      }
      return false;
    }
  }

  /**
   * Check if user has valid tokens for a specific service
   */
  async hasValidTokens(userId, serviceName) {
    try {
      await this.getUserTokens(userId, serviceName);
      const expired = await this.areTokensExpired(userId, serviceName);
      return !expired;
    } catch (error) {
      return false;
    }
  }

  /**
   * List all services that have tokens for a user
   */
  async getUserServices(userId) {
    try {
      const services = [];
      const integrationDir = await fs.readdir(this.storageBasePath);

      for (const serviceName of integrationDir) {
        const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);
        try {
          await fs.access(tokenFile);
          services.push(serviceName);
        } catch (error) {
          // File doesn't exist, skip
        }
      }

      return services;
    } catch (error) {
      console.error('❌ Error listing user services:', error.message);
      return [];
    }
  }

  /**
   * Get token metadata without decrypting the actual tokens
   */
  async getTokenMetadata(userId, serviceName) {
    try {
      const tokenFile = path.join(this.storageBasePath, serviceName, `${userId}.json`);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      return {
        userId: tokenData.userId,
        serviceName: tokenData.serviceName,
        createdAt: tokenData.createdAt,
        expiresAt: tokenData.expiresAt,
        expired: tokenData.expiresAt ? new Date(tokenData.expiresAt) <= new Date() : false
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`No tokens found for user ${userId} in service ${serviceName}`);
      }
      throw error;
    }
  }

  /**
   * Generic encryption for simple strings (e.g., API keys)
   * Uses AES-256-GCM with unique IV per encryption
   *
   * Format: ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
   * This format makes encrypted values easily identifiable and includes metadata
   *
   * Note: Uses GCM mode instead of CBC (used in encryptTokens) because:
   * - Provides authenticated encryption (integrity + confidentiality)
   * - No padding oracle vulnerabilities
   * - Better for simple string encryption without context binding
   *
   * @param {string} plaintext - The text to encrypt
   * @returns {string} Encrypted data in ENC[...] format with metadata
   */
  encryptString(plaintext) {
    this._ensureKeyInitialized();
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Invalid plaintext: must be a non-empty string');
    }

    try {
      const key = Buffer.from(this.encryptionKey, 'hex');
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
      console.error('❌ Error encrypting string:', error.message);
      throw new Error('Failed to encrypt string');
    }
  }

  /**
   * Generic decryption for simple strings (e.g., API keys)
   * Supports both new ENC[...] format and legacy base64 format
   * @param {string} encryptedData - Encrypted data in ENC[...] format or legacy base64
   * @returns {string} Decrypted plaintext
   */
  decryptString(encryptedData) {
    this._ensureKeyInitialized();
    if (!encryptedData || typeof encryptedData !== 'string') {
      throw new Error('Invalid encrypted data: must be a non-empty string');
    }

    try {
      return this._decrypt(encryptedData);
    } catch (error) {
      console.error('❌ Error decrypting string:', error.message);
      throw new Error('Failed to decrypt string. The encryption key may have changed.');
    }
  }

  /**
   * Decrypt data in ENC[AES256_GCM,data:...,iv:...,tag:...,type:str] format
   * @private
   */
  _decrypt(encryptedData) {
    // Parse ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
    const encContent = encryptedData.slice(4, -1); // Remove "ENC[" and "]"

    // Extract algorithm (first part before first comma)
    const algorithmMatch = encContent.match(/^([^,]+)/);
    if (!algorithmMatch) {
      throw new Error('Invalid ENC format: missing algorithm');
    }

    const algorithm = algorithmMatch[1];
    if (algorithm !== 'AES256_GCM') {
      throw new Error(`Unsupported encryption algorithm: ${algorithm}`);
    }

    // Use specific regex patterns for base64 values
    // Base64 uses A-Za-z0-9+/= characters
    const dataMatch = encContent.match(/data:([A-Za-z0-9+/=]+)/);
    const ivMatch = encContent.match(/iv:([A-Za-z0-9+/=]+)/);
    const tagMatch = encContent.match(/tag:([A-Za-z0-9+/=]+)/);

    if (!dataMatch || !ivMatch || !tagMatch) {
      throw new Error('Invalid ENC format: missing required fields');
    }

    const encrypted = Buffer.from(dataMatch[1], 'base64');
    const iv = Buffer.from(ivMatch[1], 'base64');
    const authTag = Buffer.from(tagMatch[1], 'base64');

    const key = Buffer.from(this.encryptionKey, 'hex');

    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt the data
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Check if a string appears to be encrypted
   * Supports both ENC[...] format and legacy base64 format
   * @param {string} value - The value to check
   * @returns {boolean} True if the value appears to be encrypted
   */
  isEncrypted(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    // Check for new ENC[...] format
    if (value.startsWith('ENC[') && value.endsWith(']')) {
      return true;
    }

    return false;
  }
}

// Export singleton instance
export default new TokenStorageService();
