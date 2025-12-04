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
    this.encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

    // Initialize encryption key if not provided
    if (!this.encryptionKey) {
      this.encryptionKey = crypto.randomBytes(32).toString('hex');
      console.warn('⚠️ Using generated encryption key. Set TOKEN_ENCRYPTION_KEY for production.');
    }

    this.algorithm = 'aes-256-gcm';
    this.storageBasePath = path.join(getRootDir(), config.CONTENTS_DIR, 'integrations');
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
    if (!encryptedData || typeof encryptedData !== 'string') {
      throw new Error('Invalid encrypted data: must be a non-empty string');
    }

    try {
      // Check if it's the new ENC[...] format
      if (encryptedData.startsWith('ENC[') && encryptedData.endsWith(']')) {
        return this._decryptEncFormat(encryptedData);
      } else {
        // Legacy format: base64 encoded with IV, tag, and data concatenated
        return this._decryptLegacyFormat(encryptedData);
      }
    } catch (error) {
      console.error('❌ Error decrypting string:', error.message);
      throw new Error('Failed to decrypt string. The encryption key may have changed.');
    }
  }

  /**
   * Decrypt data in ENC[AES256_GCM,data:...,iv:...,tag:...,type:str] format
   * @private
   */
  _decryptEncFormat(encryptedData) {
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
   * Decrypt data in legacy base64 format (for backwards compatibility)
   * @private
   */
  _decryptLegacyFormat(encryptedData) {
    // Decode from base64
    const combined = Buffer.from(encryptedData, 'base64');

    // Extract IV (first 16 bytes)
    const iv = combined.subarray(0, 16);

    // Extract auth tag (next 16 bytes)
    const authTag = combined.subarray(16, 32);

    // Extract encrypted data (remaining bytes)
    const encrypted = combined.subarray(32);

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

    // Check for legacy base64 format
    // Encrypted values contain: IV (16 bytes) + auth tag (16 bytes) + encrypted data (at least 1 byte)
    // Minimum 33 bytes = 44 base64 characters (with padding)
    // In practice, encrypted values will be longer due to actual data
    if (value.length < 44) {
      return false;
    }

    // Check if it's valid base64 (allow 0-2 padding characters)
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    return base64Regex.test(value);
  }
}

// Export singleton instance
export default new TokenStorageService();
