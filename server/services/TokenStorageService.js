import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from '../utils/logger.js';

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

    // JWT secret for token signing
    this.jwtSecret = null;
    this.jwtSecretFilePath = path.join(getRootDir(), config.CONTENTS_DIR, '.jwt-secret');

    // RSA key pair for RS256 signing
    this.rsaKeyPair = null;
    this.rsaPublicKeyPath = path.join(getRootDir(), config.CONTENTS_DIR, '.jwt-public-key.pem');
    this.rsaPrivateKeyPath = path.join(getRootDir(), config.CONTENTS_DIR, '.jwt-private-key.pem');
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
      logger.info('Using encryption key from TOKEN_ENCRYPTION_KEY environment variable', {
        component: 'TokenStorage'
      });
      return;
    }

    // Priority 2: Try to load persisted key
    try {
      const persistedKey = await fs.readFile(this.keyFilePath, 'utf8');
      if (persistedKey && persistedKey.length === 64) {
        // Validate it's a valid hex string
        if (/^[0-9a-f]{64}$/i.test(persistedKey.trim())) {
          this.encryptionKey = persistedKey.trim();
          logger.info('Using persisted encryption key from disk', { component: 'TokenStorage' });
          return;
        } else {
          logger.warn('Persisted encryption key has invalid format, generating new key', {
            component: 'TokenStorage'
          });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading encryption key file', {
          component: 'TokenStorage',
          error
        });
      }
      // File doesn't exist or error reading, will generate new key
    }

    // Priority 3: Generate new key and persist it
    this.encryptionKey = crypto.randomBytes(32).toString('hex');
    logger.warn(
      'Generated new encryption key, will be persisted to maintain API key compatibility across restarts',
      { component: 'TokenStorage' }
    );

    try {
      // Ensure contents directory exists
      const contentsDir = path.dirname(this.keyFilePath);
      await fs.mkdir(contentsDir, { recursive: true });

      // Save the key with restrictive permissions
      await fs.writeFile(this.keyFilePath, this.encryptionKey, {
        mode: 0o600 // Read/write for owner only
      });
      logger.info('Encryption key persisted to disk', {
        component: 'TokenStorage',
        keyFilePath: this.keyFilePath
      });
      logger.info(
        'Keep the key file secure and back it up. Losing it will make encrypted API keys unrecoverable.',
        { component: 'TokenStorage' }
      );
    } catch (error) {
      logger.error('Failed to persist encryption key', {
        component: 'TokenStorage',
        error
      });
      logger.warn('Encryption key is not persisted. API keys will be lost on server restart.', {
        component: 'TokenStorage'
      });
    }
  }

  /**
   * Initialize the JWT secret for token signing
   * This MUST be called before any JWT operations
   * Priority:
   * 1. Use JWT_SECRET from environment if set
   * 2. Use persisted encrypted secret from disk if exists
   * 3. Generate new secret, encrypt with encryption key, and persist it
   */
  async initializeJwtSecret() {
    // Priority 1: Environment variable (allows override, required for multi-node)
    if (process.env.JWT_SECRET && process.env.JWT_SECRET !== '${JWT_SECRET}') {
      this.jwtSecret = process.env.JWT_SECRET;
      logger.info('Using JWT secret from JWT_SECRET environment variable', {
        component: 'TokenStorage'
      });
      return;
    }

    // Priority 2: Try to load persisted encrypted secret
    try {
      const persistedData = await fs.readFile(this.jwtSecretFilePath, 'utf8');
      const trimmed = persistedData.trim();
      if (trimmed && this.isEncrypted(trimmed)) {
        this.jwtSecret = this.decryptString(trimmed);
        logger.info('Using persisted JWT secret from disk', { component: 'TokenStorage' });
        return;
      } else if (trimmed) {
        logger.warn('Persisted JWT secret has invalid format, generating new secret', {
          component: 'TokenStorage'
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading JWT secret file', {
          component: 'TokenStorage',
          error
        });
      }
      // File doesn't exist or error reading, will generate new secret
    }

    // Priority 3: Generate new secret, encrypt, and persist it
    this._ensureKeyInitialized();
    this.jwtSecret = crypto.randomBytes(64).toString('base64');
    logger.info('Generated new JWT secret', { component: 'TokenStorage' });

    try {
      const contentsDir = path.dirname(this.jwtSecretFilePath);
      await fs.mkdir(contentsDir, { recursive: true });

      const encryptedSecret = this.encryptString(this.jwtSecret);
      await fs.writeFile(this.jwtSecretFilePath, encryptedSecret, {
        mode: 0o600
      });
      logger.info('JWT secret persisted to disk (encrypted)', { component: 'TokenStorage' });
    } catch (error) {
      logger.error('Failed to persist JWT secret', {
        component: 'TokenStorage',
        error
      });
      logger.warn('JWT secret is not persisted. Tokens will be invalidated on server restart.', {
        component: 'TokenStorage'
      });
    }
  }

  /**
   * Get the initialized JWT secret
   * @returns {string|null} The JWT secret or null if not initialized
   */
  getJwtSecret() {
    return this.jwtSecret;
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
   * Reject filename components that could escape the integrations
   * directory or otherwise produce surprising on-disk paths. Both
   * `userId` (sourced from the authenticated user, but a malicious or
   * misbehaving IdP could supply arbitrary values) and `providerId`
   * (admin-defined, but routes accept it from the query string before
   * we look up the matching configured provider) are external inputs
   * from CodeQL's perspective. Enforce a conservative allowlist:
   * letters, digits, and a handful of separators commonly used in
   * stable identifiers (email-style `userId`s, UUIDs, slugified
   * provider IDs).
   *
   * Throws synchronously rather than silently rewriting the value so
   * the caller's logging carries the bad input.
   *
   * @private
   */
  _assertSafeFilenameComponent(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new Error(`Invalid ${label}: must be a non-empty string up to 256 characters`);
    }
    if (!/^[A-Za-z0-9._@+-]+$/.test(value)) {
      throw new Error(`Invalid ${label}: contains characters outside the safe filename set`);
    }
  }

  /**
   * Resolve the on-disk filename for a token blob.
   *
   * Per-provider scoping is the supported form: callers pass a
   * `providerId` and the file ends up at `<userId>__<providerId>.json`,
   * which lets a user connect to multiple instances of the same service
   * (e.g. two Office 365 tenants) without each overwriting the others.
   * `__` is used as the separator so `userId` values that contain a `.`
   * (typical for email-style IDs) don't collide with the `.json` suffix.
   *
   * Callers that omit `providerId` fall back to the legacy single-slot
   * `<userId>.json` path. Production paths always pass `providerId`; the
   * un-scoped form is kept for tests and for the migration entry point.
   *
   * Both `userId` and `providerId` are validated via
   * `_assertSafeFilenameComponent` before being interpolated into the
   * path so a malicious IdP-supplied `userId` (or a tampered URL
   * `providerId`) cannot escape `storageBasePath/serviceName/`.
   */
  _tokenFilePath(userId, serviceName, providerId) {
    this._assertSafeFilenameComponent(userId, 'userId');
    this._assertSafeFilenameComponent(serviceName, 'serviceName');
    if (providerId) {
      this._assertSafeFilenameComponent(providerId, 'providerId');
    }
    const dir = path.join(this.storageBasePath, serviceName);
    const filename = providerId ? `${userId}__${providerId}.json` : `${userId}.json`;
    // Defense-in-depth containment check: compose the candidate path,
    // resolve it to an absolute form, and reject anything that doesn't
    // sit directly inside the per-service directory. The allowlist in
    // `_assertSafeFilenameComponent` already excludes path separators,
    // but this second layer satisfies CodeQL's path-traversal analysis
    // and protects against future changes to that allowlist.
    const candidate = path.resolve(dir, filename);
    const baseDir = path.resolve(dir) + path.sep;
    if (!candidate.startsWith(baseDir)) {
      throw new Error('Resolved token-file path escapes its service directory');
    }
    return candidate;
  }

  /**
   * Like `_tokenFilePath`, but if the providerId-scoped file does not
   * exist, fall back to the legacy `<userId>.json` path so a partially-
   * migrated install still serves tokens. Once the startup migration has
   * run, this almost always resolves to the scoped path.
   */
  async _resolveExistingTokenFilePath(userId, serviceName, providerId) {
    if (providerId) {
      const scoped = this._tokenFilePath(userId, serviceName, providerId);
      try {
        await fs.access(scoped);
        return scoped;
      } catch {
        // Fall through to legacy path
      }
    }
    return this._tokenFilePath(userId, serviceName, null);
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
      logger.error('Error encrypting tokens', {
        component: 'TokenStorage',
        error
      });
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
      logger.error('Error decrypting tokens', {
        component: 'TokenStorage',
        error
      });
      throw new Error('Failed to decrypt tokens');
    }
  }

  /**
   * Store encrypted user tokens for a specific service + provider.
   *
   * `providerId` scopes the on-disk filename so the same user can
   * connect to multiple instances of the same service (e.g. two
   * Office 365 tenants or two Nextcloud servers) without each
   * overwriting the others. Callers should always pass the providerId
   * from the OAuth state — only tests omit it.
   */
  async storeUserTokens(userId, serviceName, tokens, providerId = null) {
    try {
      const encryptedTokens = this.encryptTokens(tokens, userId, serviceName);
      const now = new Date();
      const tokenData = {
        ...encryptedTokens,
        providerId: providerId || tokens?.providerId || null,
        createdAt: now.toISOString(),
        expiresAt: tokens.expiresIn
          ? new Date(now.getTime() + tokens.expiresIn * 1000).toISOString()
          : null
      };

      // Store in contents/integrations/{service} directory
      const tokenDir = path.join(this.storageBasePath, serviceName);
      await fs.mkdir(tokenDir, { recursive: true });

      const tokenFile = this._tokenFilePath(userId, serviceName, tokenData.providerId);
      await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));

      logger.info('Tokens stored for user', {
        component: 'TokenStorage',
        serviceName,
        userId,
        providerId: tokenData.providerId
      });
      return true;
    } catch (error) {
      logger.error('Error storing user tokens', {
        component: 'TokenStorage',
        error
      });
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Retrieve and decrypt user tokens for a specific service + provider.
   * Falls back to the legacy single-slot file if the scoped one is
   * missing (upgrade safety; the eager startup migration normally
   * renames legacy files first).
   */
  async getUserTokens(userId, serviceName, providerId = null) {
    try {
      const tokenFile = await this._resolveExistingTokenFilePath(userId, serviceName, providerId);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      return this.decryptTokens(tokenData, userId, serviceName);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`User not authenticated with ${serviceName}`);
      }
      logger.error('Error retrieving user tokens', {
        component: 'TokenStorage',
        error
      });
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Check if tokens are expired based on stored expiration time
   * Includes a 2-minute buffer for proactive refresh
   */
  async areTokensExpired(userId, serviceName, providerId = null) {
    try {
      const tokenFile = await this._resolveExistingTokenFilePath(userId, serviceName, providerId);
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
   * Delete user tokens for a specific service + provider (disconnect)
   */
  async deleteUserTokens(userId, serviceName, providerId = null) {
    try {
      const tokenFile = await this._resolveExistingTokenFilePath(userId, serviceName, providerId);
      await fs.unlink(tokenFile);
      logger.info('Tokens deleted for user', {
        component: 'TokenStorage',
        serviceName,
        userId,
        providerId
      });
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error deleting user tokens', {
          component: 'TokenStorage',
          error
        });
      }
      return false;
    }
  }

  /**
   * Check if user has valid tokens for a specific service + provider
   */
  async hasValidTokens(userId, serviceName, providerId = null) {
    try {
      await this.getUserTokens(userId, serviceName, providerId);
      const expired = await this.areTokensExpired(userId, serviceName, providerId);
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
      logger.error('Error listing user services', {
        component: 'TokenStorage',
        error
      });
      return [];
    }
  }

  /**
   * Get token metadata without decrypting the actual tokens
   */
  async getTokenMetadata(userId, serviceName, providerId = null) {
    try {
      const tokenFile = await this._resolveExistingTokenFilePath(userId, serviceName, providerId);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      return {
        userId: tokenData.userId,
        serviceName: tokenData.serviceName,
        providerId: tokenData.providerId || null,
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
      logger.error('Error encrypting string', {
        component: 'TokenStorage',
        error
      });
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
      logger.error('Error decrypting string', {
        component: 'TokenStorage',
        error
      });
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

  /**
   * Initialize or load RSA key pair for RS256 JWT signing
   * Priority:
   * 1. Use keys from environment variables if set
   * 2. Use persisted keys from disk if they exist
   * 3. Generate new key pair and persist it
   */
  async initializeRSAKeyPair() {
    // Priority 1: Environment variables
    if (process.env.JWT_PUBLIC_KEY && process.env.JWT_PRIVATE_KEY) {
      this.rsaKeyPair = {
        publicKey: process.env.JWT_PUBLIC_KEY,
        privateKey: process.env.JWT_PRIVATE_KEY
      };
      logger.info('Using RSA key pair from environment variables', {
        component: 'TokenStorage'
      });
      return;
    }

    // Priority 2: Try to load persisted keys
    try {
      const publicKey = await fs.readFile(this.rsaPublicKeyPath, 'utf8');
      const privateKey = await fs.readFile(this.rsaPrivateKeyPath, 'utf8');

      if (publicKey && privateKey) {
        this.rsaKeyPair = { publicKey, privateKey };
        logger.info('Using persisted RSA key pair from disk', { component: 'TokenStorage' });
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error reading RSA key pair files', {
          component: 'TokenStorage',
          error
        });
      }
      // Files don't exist or error reading, will generate new pair
    }

    // Priority 3: Generate new key pair and persist it
    logger.info('Generating new RSA key pair for JWT signing', { component: 'TokenStorage' });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    this.rsaKeyPair = { publicKey, privateKey };

    // Persist the keys
    try {
      const contentsDir = path.dirname(this.rsaPublicKeyPath);
      await fs.mkdir(contentsDir, { recursive: true });

      await fs.writeFile(this.rsaPublicKeyPath, publicKey, { mode: 0o644 });
      await fs.writeFile(this.rsaPrivateKeyPath, privateKey, { mode: 0o600 });

      logger.info('RSA key pair persisted to disk', { component: 'TokenStorage' });
      logger.info(
        'IMPORTANT: Back up these key files. Losing them will invalidate all existing JWT tokens.',
        { component: 'TokenStorage' }
      );
    } catch (error) {
      logger.error('Failed to persist RSA key pair', {
        component: 'TokenStorage',
        error
      });
      logger.warn('RSA key pair is not persisted. Keys will change on server restart.', {
        component: 'TokenStorage'
      });
    }
  }

  /**
   * Get the RSA key pair for RS256 signing
   * @returns {{publicKey: string, privateKey: string}|null} The RSA key pair or null if not initialized
   */
  getRSAKeyPair() {
    return this.rsaKeyPair;
  }

  /**
   * Get the RSA public key for RS256 verification
   * @returns {string|null} The RSA public key or null if not initialized
   */
  getRSAPublicKey() {
    return this.rsaKeyPair?.publicKey || null;
  }

  /**
   * Get the RSA private key for RS256 signing
   * @returns {string|null} The RSA private key or null if not initialized
   */
  getRSAPrivateKey() {
    return this.rsaKeyPair?.privateKey || null;
  }

  /**
   * Migrate legacy token files in `contents/integrations/*` from the
   * old single-slot `<userId>.json` layout to the per-provider
   * `<userId>__<providerId>.json` layout.
   *
   * Each legacy file is decrypted to read its `providerId` (the field
   * is also persisted in plaintext on new files but historical files
   * only carry it inside the encrypted payload). On success the file
   * is renamed; on failure (missing providerId, decryption error,
   * etc.) the file is left in place and logged so an operator can
   * decide whether to delete it. The migration runs once per process
   * start and is a no-op on already-migrated installs.
   */
  async migrateLegacyTokenFiles() {
    try {
      // Quick exit if the integrations directory has never been
      // created (fresh install).
      try {
        await fs.access(this.storageBasePath);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }

      const services = await fs.readdir(this.storageBasePath);
      let migrated = 0;
      let skipped = 0;

      for (const serviceName of services) {
        // Directory listings can technically contain anything if the
        // host filesystem was tampered with; refuse to touch directory
        // names that don't look like a normal service slug.
        try {
          this._assertSafeFilenameComponent(serviceName, 'serviceName');
        } catch (err) {
          logger.warn('Skipping integration directory with unsafe name', {
            component: 'TokenStorage',
            entry: serviceName,
            error: err.message
          });
          skipped += 1;
          continue;
        }
        const serviceDir = path.join(this.storageBasePath, serviceName);
        let stat;
        try {
          stat = await fs.stat(serviceDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const entries = await fs.readdir(serviceDir);
        for (const entry of entries) {
          // Already-scoped filenames contain the `__` separator —
          // those are new-format files and need no migration.
          if (!entry.endsWith('.json') || entry.includes('__')) continue;

          const userId = entry.slice(0, -'.json'.length);
          // Same containment check: a hostile filename in the listing
          // could otherwise flow into the rename target.
          try {
            this._assertSafeFilenameComponent(userId, 'userId');
          } catch (err) {
            logger.warn('Skipping legacy token file with unsafe name', {
              component: 'TokenStorage',
              serviceName,
              file: entry,
              error: err.message
            });
            skipped += 1;
            continue;
          }
          const oldPath = path.join(serviceDir, entry);

          let tokenData;
          try {
            tokenData = JSON.parse(await fs.readFile(oldPath, 'utf8'));
          } catch (err) {
            logger.warn('Skipping unparseable legacy token file during migration', {
              component: 'TokenStorage',
              serviceName,
              file: entry,
              error: err.message
            });
            skipped += 1;
            continue;
          }

          // The on-disk file may already carry the providerId in
          // plaintext (from this codebase) or only inside the
          // encrypted blob (older installs).
          let providerId = tokenData.providerId || null;
          if (!providerId) {
            try {
              const decrypted = this.decryptTokens(tokenData, userId, serviceName);
              providerId = decrypted.providerId || null;
            } catch (err) {
              logger.warn('Skipping legacy token file: could not recover providerId', {
                component: 'TokenStorage',
                serviceName,
                file: entry,
                error: err.message
              });
              skipped += 1;
              continue;
            }
          }

          if (!providerId) {
            logger.warn('Skipping legacy token file: no providerId in payload', {
              component: 'TokenStorage',
              serviceName,
              file: entry
            });
            skipped += 1;
            continue;
          }

          // `providerId` here came out of an encrypted payload that we
          // wrote, but defense-in-depth: a tampered on-disk file could
          // contain anything. `_tokenFilePath` runs the same check
          // internally; doing it explicitly first lets us skip rather
          // than throw out of the migration loop.
          try {
            this._assertSafeFilenameComponent(providerId, 'providerId');
          } catch (err) {
            logger.warn('Skipping legacy token file: providerId fails safety check', {
              component: 'TokenStorage',
              serviceName,
              file: entry,
              error: err.message
            });
            skipped += 1;
            continue;
          }

          const newPath = this._tokenFilePath(userId, serviceName, providerId);

          // If the new-format path already exists (unlikely but
          // possible after a partial rename) keep the new one and
          // delete the legacy file to converge.
          try {
            await fs.access(newPath);
            await fs.unlink(oldPath);
            logger.info('Removed duplicate legacy token file (scoped file already exists)', {
              component: 'TokenStorage',
              serviceName,
              file: entry,
              providerId
            });
            migrated += 1;
            continue;
          } catch {
            // Scoped path does not exist; proceed with rename.
          }

          await fs.rename(oldPath, newPath);
          migrated += 1;
          logger.info('Migrated legacy token file to per-provider path', {
            component: 'TokenStorage',
            serviceName,
            userId,
            providerId
          });
        }
      }

      if (migrated > 0 || skipped > 0) {
        logger.info('Token-file migration complete', {
          component: 'TokenStorage',
          migrated,
          skipped
        });
      }
    } catch (error) {
      logger.error('Error migrating legacy token files', {
        component: 'TokenStorage',
        error: error.message
      });
      // Non-fatal: server continues to boot, falling back to legacy
      // read paths via `_resolveExistingTokenFilePath`.
    }
  }
}

// Export singleton instance
export default new TokenStorageService();
