---
description: "How iHub's encryption key protects stored secrets and stored content, and how to keep it safe in production."
audience: admin
type: how-to
---

# Encryption Key Management

iHub Apps uses encryption to securely store sensitive data like provider API keys and user OAuth tokens. This document explains how the encryption key is managed and what you need to know for production deployments.

## Overview

All sensitive data (API keys, OAuth tokens) is encrypted using **AES-256-GCM** encryption before being stored on disk. To ensure this encrypted data can be decrypted across server restarts, the encryption key must be persistent.

The same key is the master key of [storage encryption](storage-encryption.md). When
`storage.encryption.enabled` is on, it also protects chats, uploaded files, artifacts and run
history. Losing the key then means losing that content. See
[Storage Encryption and the Key](#storage-encryption-and-the-key).

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
   - Exception: no key is generated while the installation holds data that was encrypted with a
     master key. The server refuses to start instead. See
     [The server does not create a new key over encrypted data](#the-server-does-not-create-a-new-key-over-encrypted-data).
   - Exception: no key is generated when `contents/.encryption-key` exists but does not hold a
     64-character hex key (an empty file, a file cut short, other text). The server refuses to
     start (`MASTER_KEY_INVALID`) and leaves the file as it is. See
     [Key File Is Not Usable](#key-file-is-not-usable).
   - Only a server start generates a key. `npm run storage:check`, `npm run storage:show` and
     `npm run storage:encrypt -- --dry-run` never create one.

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

## Storage Encryption and the Key

With [storage encryption](storage-encryption.md) turned on (`storage.encryption.enabled`, the
default of a fresh installation), the same master key also protects the stored content: chats,
uploaded files, artifacts, run history, agent memory and, when blobs are kept in S3, every object
in the bucket. The key is no longer only about saved API keys.

### Losing the key means losing the content

- Without the master key, encrypted chats, files and run history cannot be read. There is no
  recovery, no reset and no second key.
- Nothing can be re-entered. An API key can be typed in again; a chat or an uploaded file cannot.
- An S3 bucket without the key is unreadable data.

### The server does not create a new key over encrypted data

When no key is found, the server normally generates one (see [First Server Start](#first-server-start)).
It does not do that when the installation holds encrypted data. A missing or unreadable key then
usually means that the key volume is not mounted or the key file was not restored, and a new key
would start the server on data it cannot read.

In that case the server logs `MASTER_KEY_REQUIRED`, names the key id the data was written with and
ends with exit code 1. This also happens with the switch turned off again, as long as encrypted
data exists. The server decides this from `contents/data/.at-rest.json` and
`contents/data/.at-rest-keycheck`.

What to do: restore `contents/.encryption-key` from a backup, or set `TOKEN_ENCRYPTION_KEY` to the
key the data was written with. Do not delete the two files named above to get past the check; the
data stays unreadable.

A key that is present but is not the one the data was written with also stops the start. The
message names the key id the data expects and the key id that was found.

### Where to keep the key

By default the key is the file `contents/.encryption-key`, in the same folder as the data it
protects. **A copy of `contents/` then reads everything**: a backup, a volume snapshot or a copied
folder contains the data and the key.

Storage encryption protects against someone who reads the disk or the bucket only when the key is
kept apart from them:

- set `TOKEN_ENCRYPTION_KEY` from a secret store, to the same value as the key file (the variable
  has priority over the file; remove the file from the volume once the variable is in place and
  you have a copy of the key), or
- keep the key file on another volume than the data.

For S3 this matters most: the bucket is only as protected as the key is separate from the people
and systems that can read the bucket.

### Backup and restore

Back up three things, and restore them from the same point in time:

| What                                     | Why                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The master key                           | Without it nothing else can be read. Include every earlier key that is still set as `TOKEN_ENCRYPTION_KEY_PREVIOUS`. |
| `contents/`                              | Configuration, chats, metadata, the state record `data/.at-rest.json` and the key-check object.                      |
| The S3 bucket, when blobs are kept there | The files. The documents in `contents/data/` refer to them.                                                          |

- **Keep the key apart from the data and the bucket.** A backup that holds the data and the key
  together is as sensitive as unencrypted data. A backup of the bucket without the key is useless.
- **Restore them together.** A bucket that is newer than `contents/` holds objects no document
  refers to, and the server removes such objects. A bucket that is older lacks files that chats
  refer to.
- Restore `contents/` as a whole. Single unencrypted files copied into an encrypted installation
  are refused (see [Storage Encryption](storage-encryption.md#what-a-read-does-with-unencrypted-data)).

**The admin backup export** (Admin → Backup & Restore):

- It contains `contents/.encryption-key` when the key is a file. The ZIP is then as sensitive as
  unencrypted data, although the chats inside it are encrypted. Store it like a key.
- When the key comes from `TOKEN_ENCRYPTION_KEY`, the ZIP holds no key. It is then useless without
  the key, and an import needs the same key in the environment.
- **It does not contain the S3 bucket.** With blobs in S3, the export is not a full backup. Back up
  the bucket with the tools of your S3 service.
- `contents/.backups/` keeps what an import replaced, in the form it had then. Copies from before
  the switch was turned on are unencrypted. Remove them when you no longer need them.

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

With storage encryption on, the master key also wraps the keys of every stored chat, file and log.
There is no job yet that re-encrypts old data under a new key. After a key change:

- Old data stays encrypted under the old key and needs `TOKEN_ENCRYPTION_KEY_PREVIOUS` to be read.
  Data that is written again (a chat that continues) moves to the new key by itself. Finished
  chats, run history and files do not.
- **Keep `TOKEN_ENCRYPTION_KEY_PREVIOUS` set.** Removing it makes the old data unreadable.
- **Do not change the key a second time.** Only one previous key is read. A second change makes
  everything written under the first key unreadable.
- The server logs a warning at the first start with the new key and records the earlier key id in
  `contents/data/.at-rest.json` (`previousKeyId`).

Change the key only when you must, for example after the key was exposed.

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
   documents encrypted under it are lost and have to be uploaded again. With storage encryption
   on, all chats, uploaded files and run history encrypted under it are lost as well

### Key File Missing After Deployment

**Cause:** The `contents/.encryption-key` file was not included in the deployment or was deleted.

**Solutions:**
1. If you have a backup, restore the key file
2. If no backup exists, use `TOKEN_ENCRYPTION_KEY` environment variable instead
3. Re-enter all encrypted API keys via admin panel

If the installation holds data encrypted by [storage encryption](storage-encryption.md), the server
does not start without the original key and does not create a new one (`MASTER_KEY_REQUIRED` in the
log). Steps 2 and 3 do not help then: only the original key, from a backup or as
`TOKEN_ENCRYPTION_KEY`, makes the data readable again.

### Key File Is Not Usable

**Cause:** `contents/.encryption-key` exists but does not hold a 64-character hex key: it is empty,
was cut short by a full disk or an interrupted copy, or holds other text (quotes, a comment, a
second line of text). The log shows `MASTER_KEY_INVALID` and the server ends with exit code 1.

The server never overwrites this file and never generates a new key in its place. A file that is
there is taken as a sign that a key existed; replacing it would make everything encrypted with the
lost key unreadable for good.

**Solutions:**
1. Restore the file from a backup, or put the 64 hex characters into it (no quotes, nothing else;
   a final line break is accepted)
2. Or set `TOKEN_ENCRYPTION_KEY` to the key
3. Remove the file only on an installation that has no encrypted data and no saved credentials.
   A new key is then generated at the next start

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
