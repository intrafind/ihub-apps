# Environment Variable Encryption

This document explains how to use the environment variable encryption feature in iHub Apps to securely store sensitive credentials like passwords and API keys.

## Overview

iHub Apps supports encryption of environment variables in `.env` files using AES-256-GCM encryption. This uses the same `TokenStorageService` that encrypts model API keys in the admin UI, ensuring consistency across the application.

Encryption is supported for:

- API keys (OpenAI, Anthropic, Google, etc.)
- LDAP/AD bind passwords
- Database credentials
- OAuth secrets
- Any other sensitive configuration values

## Quick Start

### 1. Set Up Encryption Key

Generate a secure encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add it to your `.env` file:

```bash
TOKEN_ENCRYPTION_KEY=your_generated_64_character_hex_key
```

### 2. Encrypt Sensitive Values

**Option A: Using the CLI Tool**

```bash
node server/utils/encryptEnvValue.js "your_secret_password"
```

**Option B: Using the Admin UI** (recommended)

1. Log in to the Admin UI
2. Go to the System Settings page
3. Use the "Encrypt Value" tool
4. Enter your plain text value
5. Copy the encrypted output

### 3. Use in .env File

Replace plain text values with encrypted ones:

**Before (NOT SECURE):**
```bash
LDAP_ADMIN_PASSWORD=myPlainTextPassword
OPENAI_API_KEY=sk-your-openai-key-here
```

**After (SECURE):**
```bash
LDAP_ADMIN_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
OPENAI_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

### 4. Start Application

The application automatically decrypts encrypted values on startup. No code changes needed!

```bash
npm start
```

You'll see:
```
🔓 Decrypted environment variable: LDAP_ADMIN_PASSWORD
🔓 Decrypted environment variable: OPENAI_API_KEY
✅ Decrypted 2 environment variable(s)
```

## Encryption Format

Encrypted values use this format:
```
ENC[AES256_GCM,data:<base64>,iv:<base64>,tag:<base64>,type:str]
```

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: Derived from `TOKEN_ENCRYPTION_KEY` (32 bytes hex)
- **IV**: Random 16-byte initialization vector (unique per encryption)
- **Tag**: Authentication tag for integrity verification
- **Compatibility**: Same format as model API keys stored through the admin UI

## Admin UI Integration

The encryption feature is fully integrated with the existing admin UI:

### Encrypting Values via Admin UI

1. Navigate to **Admin → System Settings**
2. Find the **"Encrypt Value for .env"** section
3. Enter your plain text value (password, API key, etc.)
4. Click **"Encrypt"**
5. Copy the encrypted value to your clipboard
6. Add it to your `.env` file

### API Endpoint

The admin UI uses the `/api/admin/auth/encrypt-value` endpoint:

```bash
curl -X POST http://localhost:3000/api/admin/auth/encrypt-value \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{"plaintext": "my-secret-password"}'
```

Response:
```json
{
  "encrypted": "ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]",
  "format": "AES256_GCM",
  "message": "Value encrypted successfully. Copy this to your .env file."
}
```

### Consistency with Model API Keys

The environment variable encryption uses the same `TokenStorageService` that handles:
- Model API key encryption in the admin UI
- OAuth token storage per user
- Other sensitive data encryption

This ensures:
- ✅ Same encryption algorithm across the application
- ✅ Same encryption key for all encrypted values
- ✅ No code duplication
- ✅ Consistent security practices

## Security Best Practices

### 1. Protect the Encryption Key

✅ **DO:**
- Store `TOKEN_ENCRYPTION_KEY` securely (password managers, secret vaults)
- Use different keys for dev/staging/production
- Never commit the encryption key to version control
- Back up the key in multiple secure locations

❌ **DON'T:**
- Share the encryption key in plain text
- Reuse encryption keys across different systems
- Store the key in the same repository as encrypted values

### 2. Key Management

If you lose the encryption key, you **cannot** decrypt your values:

```bash
# Back up your key securely
echo $TOKEN_ENCRYPTION_KEY > /secure/location/encryption-key.txt

# Or store in a password manager/vault
```

### 3. Rotating Credentials

When rotating credentials:

1. Generate new credential
2. Encrypt new value: `node server/utils/encryptEnvValue.js "new_password"`
3. Update `.env` file with new encrypted value
4. Restart application

### 4. Environment-Specific Keys

Use different encryption keys per environment:

**.env.development:**
```bash
TOKEN_ENCRYPTION_KEY=dev_key_here...
```

**.env.production:**
```bash
TOKEN_ENCRYPTION_KEY=prod_key_here...
```

## Testing Decryption

Verify that encryption/decryption works:

```bash
# Set test encrypted value in environment
export TOKEN_ENCRYPTION_KEY=your_key_here
export TEST_VAR=$(node server/utils/encryptEnvValue.js "test-value" | grep '^ENC')

# Test decryption
node server/utils/testEnvDecryption.js
```

## Troubleshooting

### "Failed to decrypt environment variable"

**Cause:** Encryption key mismatch or corrupted encrypted value

**Solution:**
1. Verify `TOKEN_ENCRYPTION_KEY` matches the key used for encryption
2. Re-encrypt the value with the correct key
3. Check for copy-paste errors (encrypted values are long strings)

### "Using generated encryption key"

**Cause:** `TOKEN_ENCRYPTION_KEY` not set in environment

**Solution:**
Generate and set the key in your `.env` file:
```bash
# Generate key
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
# Add to .env file
echo "TOKEN_ENCRYPTION_KEY=$KEY" >> .env
```

### Encrypted value still appears encrypted

**Cause:** Decryption failed silently

**Check:**
1. Value starts with `ENC[` and ends with `]`
2. No line breaks or spaces in encrypted string
3. Encryption key is set before application starts

## Migration Guide

### From Plain Text to Encrypted

1. **Backup current .env:**
   ```bash
   cp .env .env.backup
   ```

2. **Generate encryption key:**
   ```bash
   KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   echo "TOKEN_ENCRYPTION_KEY=$KEY" >> .env
   ```

3. **Encrypt each sensitive value:**
   ```bash
   # For each sensitive variable
   node server/utils/encryptEnvValue.js "current_plain_value"
   # Copy encrypted output to .env
   ```

4. **Test before deploying:**
   ```bash
   node server/utils/testEnvDecryption.js
   npm start
   ```

## Examples

### LDAP Authentication

```bash
# Encrypt LDAP passwords
node server/utils/encryptEnvValue.js "ldap_bind_password"

# .env file
LDAP_ADMIN_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
AD_BIND_USER=serviceaccount@domain.com
AD_BIND_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

### Multiple API Keys

```bash
# Encrypt all API keys
for key in "sk-openai..." "sk-ant-..." "AIza..."; do
  node server/utils/encryptEnvValue.js "$key"
done

# .env file
OPENAI_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
ANTHROPIC_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
GOOGLE_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

## Limitations

- ❌ Cannot decrypt values encrypted with a different key
- ❌ Losing the encryption key means re-encrypting all values
- ❌ Encrypted values are longer than plain text (may affect .env file size)
- ✅ Automatic decryption only works for `.env` files loaded by the application
- ✅ Tool does not automatically scan and encrypt existing plain-text values in your repository (you must manually encrypt each value)

## Advanced Usage

### Programmatic Encryption

```javascript
import crypto from 'crypto';

function encryptValue(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  
  return `ENC[AES256_GCM,data:${encrypted},iv:${iv.toString('base64')},tag:${tag.toString('base64')},type:str]`;
}
```

### Batch Encryption Script

```bash
#!/bin/bash
# encrypt-all-secrets.sh

declare -A secrets=(
  ["OPENAI_API_KEY"]="secret_value_1"
  ["LDAP_PASSWORD"]="secret_value_2"
  ["DATABASE_URL"]="secret_value_3"
)

for key in "${!secrets[@]}"; do
  encrypted=$(node server/utils/encryptEnvValue.js "${secrets[$key]}" | grep '^ENC')
  echo "$key=$encrypted"
done
```

## See Also

- [LDAP Authentication Documentation](../docs/ldap-ntlm-authentication.md)
- [Security Guide](../docs/security.md)
- [Configuration Guide](../docs/platform.md)

## Support

For issues or questions about environment variable encryption:

1. Check troubleshooting section above
2. Verify encryption key is correct and consistent
3. Review server logs for decryption errors
4. Contact support if issues persist
