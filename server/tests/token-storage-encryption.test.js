/**
 * TokenStorageService encryption — unit tests.
 *
 * encryptTokens/decryptTokens store OAuth access/refresh tokens for
 * Office365/GoogleDrive/Nextcloud integrations. They now use authenticated
 * AES-256-GCM instead of unauthenticated AES-256-CBC, while still accepting
 * the legacy CBC format so tokens written before this change keep decrypting.
 */
import crypto from 'crypto';
import tokenStorage from '../services/TokenStorageService.js';

const VALID_HEX_KEY = 'a'.repeat(64);

describe('TokenStorageService token encryption', () => {
  const originalKey = tokenStorage.encryptionKey;

  beforeAll(() => {
    tokenStorage.encryptionKey = VALID_HEX_KEY;
  });

  afterAll(() => {
    tokenStorage.encryptionKey = originalKey;
  });

  test('round-trips tokens using authenticated AES-256-GCM', () => {
    const tokens = { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 };
    const encrypted = tokenStorage.encryptTokens(tokens, 'user-1', 'office365');

    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.authTag).toEqual(expect.any(String));

    const decrypted = tokenStorage.decryptTokens(encrypted, 'user-1', 'office365');
    expect(decrypted).toEqual(tokens);
  });

  test('still decrypts tokens stored in the legacy unauthenticated AES-256-CBC format', () => {
    // Hand-build a payload the way the old encryptTokens() used to, before
    // this fix switched to GCM, to prove old on-disk tokens keep working.
    const key = Buffer.from(VALID_HEX_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    const userId = 'user-legacy';
    const serviceName = 'office365';
    const context = crypto.createHash('sha256').update(`${userId}:${serviceName}`).digest();

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const tokens = { accessToken: 'legacy-at', refreshToken: 'legacy-rt' };
    let encrypted = cipher.update(
      JSON.stringify({ ...tokens, context: context.toString('hex') }),
      'utf8',
      'hex'
    );
    encrypted += cipher.final('hex');

    const legacyPayload = {
      encrypted,
      iv: iv.toString('hex'),
      userId,
      serviceName,
      contextHash: context.toString('hex')
      // no `algorithm`/`authTag` — matches what pre-fix encryptTokens() wrote
    };

    const decrypted = tokenStorage.decryptTokens(legacyPayload, userId, serviceName);
    expect(decrypted).toEqual(tokens);
  });

  test('rejects a GCM payload whose ciphertext has been tampered with', () => {
    const tokens = { accessToken: 'at-2', refreshToken: 'rt-2' };
    const encrypted = tokenStorage.encryptTokens(tokens, 'user-2', 'nextcloud');

    const tampered = {
      ...encrypted,
      encrypted:
        encrypted.encrypted.slice(0, -2) + (encrypted.encrypted.slice(-2) === '00' ? '11' : '00')
    };

    expect(() => tokenStorage.decryptTokens(tampered, 'user-2', 'nextcloud')).toThrow(
      'Failed to decrypt tokens'
    );
  });

  test('rejects a GCM payload whose auth tag has been tampered with', () => {
    const tokens = { accessToken: 'at-3', refreshToken: 'rt-3' };
    const encrypted = tokenStorage.encryptTokens(tokens, 'user-3', 'googledrive');

    const tampered = {
      ...encrypted,
      authTag: encrypted.authTag.slice(0, -2) + (encrypted.authTag.slice(-2) === '00' ? '11' : '00')
    };

    expect(() => tokenStorage.decryptTokens(tampered, 'user-3', 'googledrive')).toThrow(
      'Failed to decrypt tokens'
    );
  });

  test('rejects tokens encrypted for a different user/service context', () => {
    const tokens = { accessToken: 'at-4' };
    const encrypted = tokenStorage.encryptTokens(tokens, 'user-4', 'office365');

    expect(() => tokenStorage.decryptTokens(encrypted, 'user-4', 'nextcloud')).toThrow(
      'Failed to decrypt tokens'
    );
  });
});

describe('TokenStorageService.initializeEncryptionKey env var validation', () => {
  const originalEnvKey = process.env.TOKEN_ENCRYPTION_KEY;
  const originalKey = tokenStorage.encryptionKey;

  afterEach(() => {
    if (originalEnvKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = originalEnvKey;
    }
    tokenStorage.encryptionKey = originalKey;
  });

  test('accepts a valid 64-character hex key', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_HEX_KEY;
    await tokenStorage.initializeEncryptionKey();
    expect(tokenStorage.encryptionKey).toBe(VALID_HEX_KEY);
  });

  test('throws on a malformed (non-hex/wrong-length) key instead of limping along', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'not-a-valid-hex-key';
    await expect(tokenStorage.initializeEncryptionKey()).rejects.toThrow(/64-character hex string/);
  });
});
