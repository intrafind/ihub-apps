# Encryption Key Management

iHub Apps uses encryption to securely store sensitive data like provider API keys and user OAuth tokens. This document explains how the encryption key is managed and what you need to know for production deployments.

## Overview

All sensitive data (API keys, OAuth tokens) is encrypted using **AES-256-GCM** encryption before being stored on disk. To ensure this encrypted data can be decrypted across server restarts, the encryption key must be persistent.

## Encryption Key Storage

### Priority Order

The system uses a 3-tier priority system for the encryption key:

1. **Environment Variable** (Highest Priority)
   - Variable: `TOKEN_ENCRYPTION_KEY`
   - Use case: Production environments where you want explicit control
   - Format: 64-character hex string (32 bytes)
   
2. **Persisted Key File** (Auto-generated)
   - Location: `contents/.encryption-key`
   - Created automatically on first server start if no environment variable is set
   - File permissions: `600` (read/write for owner only)
   
3. **Generated Key** (Fallback)
   - If neither above exists, a new key is generated
   - The new key is automatically persisted to `contents/.encryption-key`

### First Server Start

On the first server start (or if the key file is missing), you'll see:

```
⚠️  Generated new encryption key. This will be persisted to maintain API key compatibility across restarts.
✅ Encryption key persisted to: /path/to/contents/.encryption-key
⚠️  IMPORTANT: Keep this file secure and back it up. Losing it will make encrypted API keys unrecoverable.
```

### Subsequent Server Starts

On subsequent starts, if using the persisted key:

```
🔐 Using persisted encryption key from disk
```

If using an environment variable:

```
🔐 Using encryption key from TOKEN_ENCRYPTION_KEY environment variable
```

## Production Deployment

### Option 1: Use Persisted Key File (Recommended for Single Instance)

**Advantages:**
- Zero configuration required
- Key is automatically managed
- Simple setup

**Setup:**
1. Start the server - key is auto-generated
2. Backup `contents/.encryption-key` to a secure location
3. Ensure `contents/` directory persists across deployments
4. In case of data loss, restore the key file from backup

**Important:**
- The `contents/.encryption-key` file must persist across deployments
- Include it in your backup strategy
- Do NOT commit it to version control (already in `.gitignore`)

### Option 2: Use Environment Variable (Recommended for Multiple Instances)

**Advantages:**
- Explicit control over the encryption key
- Same key can be shared across multiple server instances
- Better for containerized deployments

**Setup:**

1. Generate a secure encryption key:
   ```bash
   # Generate a 32-byte (64 hex character) encryption key
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Add to your `.env` file:
   ```env
   TOKEN_ENCRYPTION_KEY=your_64_character_hex_key_here
   ```

3. For Docker/Kubernetes, set as environment variable:
   ```yaml
   # docker-compose.yml
   environment:
     - TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}
   ```

4. Ensure the key is stored securely in your secrets management system

## Security Best Practices

### Key Storage

✅ **DO:**
- Store the key in a secure secrets management system (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault)
- Use file permissions `600` for the key file
- Backup the encryption key securely
- Rotate the key periodically (see Migration section)

❌ **DON'T:**
- Commit the encryption key to version control
- Share the key via email or messaging
- Store the key in plain text in configuration files
- Use the same key across different environments (dev/staging/prod)

### Access Control

- Limit access to the `contents/.encryption-key` file to the application user only
- Use environment variables for production deployments
- Monitor access to the key file/environment variable

## Key Rotation

The same master key wraps the per-document keys of project files (the extracted text of
uploaded and picked documents, see `docs/projects.md`). Those files are **not** re-entered by
anyone: a key that is dropped takes every project document with it. Rotate as follows:

1. **Keep the old key available**: set `TOKEN_ENCRYPTION_KEY_PREVIOUS` to the key that is
   being replaced (the value of `TOKEN_ENCRYPTION_KEY`, or the content of
   `contents/.encryption-key`). Project files wrapped under it stay readable; new files are
   wrapped under the new key.

2. **Set the new key**: generate a key with the command above and put it in
   `TOKEN_ENCRYPTION_KEY`. Do not delete `contents/.encryption-key` while any project holds
   documents unless its value is in `TOKEN_ENCRYPTION_KEY_PREVIOUS`.

3. **Re-enter what is not rewrapped**: provider API keys (`contents/config/providers.json`)
   are re-entered via the admin panel, users re-authenticate their OAuth integrations
   (`contents/integrations/{service}/{userId}.json`). Project files need nothing.

4. **Keep `TOKEN_ENCRYPTION_KEY_PREVIOUS` set** until every project document has been
   rewrapped under the new key (a later release adds the rewrap; until then the previous key
   stays configured). Only one previous key is read, so rotate again only after that.

## Troubleshooting

### "Failed to decrypt string. The encryption key may have changed."

**Cause:** The encryption key used to encrypt the data is different from the current key.

**Solutions:**
1. Check if `TOKEN_ENCRYPTION_KEY` environment variable was recently changed
2. Verify `contents/.encryption-key` file exists and hasn't been corrupted
3. If key is lost, you'll need to re-enter encrypted data (API keys, OAuth tokens); project
   documents encrypted under it are lost and have to be uploaded again

### Key File Missing After Deployment

**Cause:** The `contents/.encryption-key` file was not included in the deployment or was deleted.

**Solutions:**
1. If you have a backup, restore the key file
2. If no backup exists, use `TOKEN_ENCRYPTION_KEY` environment variable instead
3. Re-enter all encrypted API keys via admin panel

### Multiple Server Instances Using Different Keys

**Cause:** Each instance generated its own encryption key.

**Solution:**
1. Choose one key to use across all instances
2. Set `TOKEN_ENCRYPTION_KEY` environment variable on all instances
3. OR copy the same `.encryption-key` file to all instances

## Migration Scenarios

### From No Key Persistence (Old Version) to Key Persistence (New Version)

**Automatic Migration:**
- On first start with the new version, a new encryption key is generated and persisted
- Existing encrypted API keys will fail to decrypt (different key)
- Admin must re-enter all provider API keys via the admin panel

**Manual Migration (if you know the old key):**
1. If the old key was in logs, extract it
2. Set as `TOKEN_ENCRYPTION_KEY` environment variable
3. Server will use this key instead of generating a new one
4. Existing encrypted data will continue to work

### Moving from Single Instance to Multiple Instances

1. Stop all server instances
2. Copy `contents/.encryption-key` from the primary instance
3. Set `TOKEN_ENCRYPTION_KEY` environment variable on all instances using this key value
4. Start all instances
5. All instances will now use the same encryption key

## Technical Details

- **Algorithm:** AES-256-GCM (Galois/Counter Mode)
- **Key Size:** 256 bits (32 bytes, 64 hex characters)
- **Format:** Encrypted values use format `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`
- **IV:** Randomly generated per encryption (16 bytes)
- **Authentication:** GCM provides built-in authentication tag

## Support

If you encounter issues with encryption key management:

1. Check server logs for encryption-related warnings/errors
2. Verify file permissions on `contents/.encryption-key` (should be `600`)
3. Ensure environment variable format is correct (64 hex characters)
4. Review this documentation for configuration best practices
