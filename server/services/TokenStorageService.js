import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

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
    this.storageBasePath = path.join(process.cwd(), 'contents', 'integrations');
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
      const tokenData = {
        ...encryptedTokens,
        createdAt: new Date().toISOString(),
        expiresAt: tokens.expiresIn
          ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
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

      return expiresAt <= now;
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
}

// Export singleton instance
export default new TokenStorageService();
