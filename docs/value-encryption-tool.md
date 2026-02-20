# Value Encryption Tool

The Value Encryption Tool in the Admin System page allows administrators to encrypt sensitive values (like passwords, API keys, secrets) to store them securely in `.env` files or configuration files.

## Overview

- **Location**: Admin → System → Value Encryption Tool
- **Access**: Requires admin privileges
- **Purpose**: Encrypt plaintext values for secure storage
- **Format**: Uses AES-256-GCM encryption via TokenStorageService

## Features

- ✅ One-way encryption (encrypt only, no decrypt via UI)
- ✅ Copy-to-clipboard functionality
- ✅ Real-time validation
- ✅ Secure AES-256-GCM encryption
- ✅ Compatible with existing TokenStorageService
- ✅ Encrypted values automatically decrypted at runtime

## Usage

### Step 1: Navigate to Admin System Page

1. Log in to iHub Apps as an administrator
2. Navigate to **Admin → System**
3. Scroll to the **Value Encryption Tool** section

### Step 2: Encrypt a Value

1. Enter your plaintext value (password, API key, etc.) in the input field
2. Click the **"Encrypt Value"** button
3. The encrypted value will appear in the text area below

### Step 3: Copy and Store

1. Click the **"Copy"** button to copy the encrypted value to clipboard
2. Store the encrypted value in your `.env` file or configuration

### Step 4: Use in Environment

The encrypted value can be used in environment variables and will be automatically decrypted when the application loads it.

## Example

### Encrypting a Password

**Plaintext Input:**
```
my-secret-password-123
```

**Encrypted Output:**
```
ENC[AES256_GCM,data:iUKy/kl7itql4QehbnMdN2QB30+eqw==,iv:Lrpa0jo1TMwsxqFevbrIhw==,tag:q7VzC7mPpsEDLpX6KrNNFA==,type:str]
```

### Using in .env File

Add the encrypted value to your `.env` file:

```bash
# LDAP Admin Password (encrypted)
LDAP_ADMIN_PASSWORD=ENC[AES256_GCM,data:iUKy/kl7itql4QehbnMdN2QB30+eqw==,iv:Lrpa0jo1TMwsxqFevbrIhw==,tag:q7VzC7mPpsEDLpX6KrNNFA==,type:str]

# Active Directory Bind Password (encrypted)
AD_BIND_PASSWORD=ENC[AES256_GCM,data:abc123...,iv:xyz789...,tag:def456...,type:str]

# API Key (encrypted)
CUSTOM_API_KEY=ENC[AES256_GCM,data:ghi789...,iv:jkl012...,tag:mno345...,type:str]
```

### Automatic Decryption

When the application loads environment variables, it automatically detects and decrypts values in `ENC[...]` format:

```javascript
// The application automatically handles decryption
const password = process.env.LDAP_ADMIN_PASSWORD;
// password will contain the decrypted plaintext value
```

## Security Considerations

### Safe to Store in Version Control

- Encrypted values are safe to commit to version control (Git, etc.)
- The encryption key is stored separately in `contents/.encryption-key`
- Without the encryption key, encrypted values cannot be decrypted

### Encryption Key Management

**Important**: Keep the encryption key secure!

- **Key Location**: `contents/.encryption-key`
- **Backup**: Always backup this file securely
- **Multi-Server**: For multi-server deployments, use the same key across all servers

You can also set the encryption key via environment variable:

```bash
export TOKEN_ENCRYPTION_KEY=your-64-char-hex-key
```

### One-Way Operation

- The admin UI only provides encryption, not decryption
- This prevents accidental exposure of secrets through the UI
- Decryption happens automatically at runtime by the application

## API Endpoint

The encryption tool uses the following API endpoint:

**POST** `/api/admin/encrypt-value`

**Request:**
```json
{
  "value": "plaintext-to-encrypt"
}
```

**Response:**
```json
{
  "encryptedValue": "ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]",
  "message": "Value encrypted successfully"
}
```

**Error Responses:**
- `400`: Invalid value (empty or already encrypted)
- `401`: Authentication required
- `403`: Admin access required
- `500`: Encryption failed

## Use Cases

### LDAP/Active Directory Passwords

Encrypt passwords for LDAP/AD authentication:

```bash
# Before
LDAP_ADMIN_PASSWORD=PlainTextPassword123

# After
LDAP_ADMIN_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

### API Keys for LLM Providers

Encrypt API keys for OpenAI, Anthropic, Google, etc.:

```bash
# Before
OPENAI_API_KEY=sk-abc123def456...

# After
OPENAI_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

### Database Credentials

Encrypt database passwords:

```bash
# Before
DB_PASSWORD=my_database_password

# After
DB_PASSWORD=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

### OAuth Client Secrets

Encrypt OAuth client secrets:

```bash
# Before
OAUTH_CLIENT_SECRET=secret_abc123

# After
OAUTH_CLIENT_SECRET=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

## Troubleshooting

### Encryption Key Missing

If you see errors about missing encryption key:

1. Check that `contents/.encryption-key` exists
2. Ensure the file has proper read permissions (600)
3. If using environment variable, verify `TOKEN_ENCRYPTION_KEY` is set

### Decryption Fails

If decryption fails:

1. Verify the encryption key hasn't changed
2. Check that the encrypted value format is correct (starts with `ENC[`)
3. Ensure the value hasn't been corrupted (no line breaks, extra spaces)

### Value Already Encrypted Error

If you see "Value is already encrypted":

- The input value is already in `ENC[...]` format
- You don't need to encrypt it again
- Use the value as-is in your configuration

## Technical Details

### Encryption Algorithm

- **Algorithm**: AES-256-GCM
- **Key Size**: 256 bits (32 bytes)
- **IV Size**: 128 bits (16 bytes)
- **Authentication**: GCM provides authenticated encryption

### Format Structure

```
ENC[AES256_GCM,data:<base64>,iv:<base64>,tag:<base64>,type:str]
```

- **data**: Base64-encoded encrypted data
- **iv**: Base64-encoded initialization vector
- **tag**: Base64-encoded authentication tag
- **type**: Value type (always "str" for strings)

### TokenStorageService Integration

The encryption tool uses the existing `TokenStorageService` which provides:

- Consistent encryption across the application
- Secure key management
- Automatic decryption at runtime
- Support for both environment variables and configuration files

## Related Documentation

- [LDAP/NTLM Authentication](./ldap-ntlm-authentication.md)
- [Environment Variables](./environment-variables.md)
- [Security Best Practices](./security.md)
- [TokenStorageService](./token-storage-service.md)
