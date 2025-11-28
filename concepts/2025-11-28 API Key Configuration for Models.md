# API Key Configuration for Models

**Date:** 2025-11-28  
**Status:** Implemented  
**Feature:** Allow users to configure API keys for LLM models in the admin interface

## Overview

This feature enables administrators to configure API keys for individual AI models directly through the admin interface. API keys are stored encrypted on the server side, providing a secure alternative to managing keys solely through environment variables.

## Problem Statement

Previously, API keys for AI models could only be configured through environment variables. This approach had several limitations:

1. **Inflexibility**: Changing API keys required server restart
2. **Single Key per Provider**: All models from the same provider shared one key
3. **Security Risk**: Keys stored in plaintext in environment files
4. **User Experience**: Non-technical users couldn't manage API keys without server access

## Solution

### Architecture

The solution implements a three-tier key resolution strategy:

1. **Model-specific Encrypted Key** (Highest Priority)
   - Stored encrypted in model configuration
   - Can be configured per-model via admin interface
   
2. **Model-specific Environment Variable**
   - e.g., `GPT_4_AZURE1_API_KEY` for model ID "gpt-4-azure1"
   
3. **Provider Environment Variable** (Fallback)
   - e.g., `OPENAI_API_KEY` for all OpenAI models

### Components

#### 1. Encryption Service (`server/services/EncryptionService.js`)

A dedicated service for encrypting and decrypting sensitive data:

```javascript
class EncryptionService {
  encrypt(plaintext)  // Returns base64-encoded encrypted data
  decrypt(encryptedData)  // Returns plaintext
  isEncrypted(value)  // Checks if value appears to be encrypted
}
```

**Security Features:**
- AES-256-GCM encryption algorithm
- Unique initialization vector (IV) per encryption operation
- Authentication tag for integrity verification
- Key derived from JWT_SECRET using scrypt

**Data Format:**
Encrypted data is stored as base64 string containing:
- 16 bytes: Initialization Vector (IV)
- 16 bytes: Authentication Tag
- Remaining: Encrypted data

#### 2. Model Schema Extension

Added optional fields to model configuration:

```json
{
  "apiKey": "string (encrypted)",
  "apiKeyEncrypted": "boolean"
}
```

#### 3. API Key Resolution (`server/utils.js`)

Enhanced `getApiKeyForModel()` function:

```javascript
export async function getApiKeyForModel(modelId) {
  // 1. Check for stored encrypted key in model config
  if (model.apiKey) {
    return encryptionService.decrypt(model.apiKey);
  }
  
  // 2. Check for model-specific environment variable
  if (process.env[`${MODEL_ID}_API_KEY`]) {
    return process.env[`${MODEL_ID}_API_KEY`];
  }
  
  // 3. Check for provider environment variable
  return process.env[`${PROVIDER}_API_KEY`];
}
```

#### 4. Admin API Endpoints

Modified endpoints to handle API key encryption/masking:

**GET `/api/admin/models` & `/api/admin/models/:modelId`**
- Masks API keys in response (`••••••••`)
- Includes `apiKeySet` boolean flag
- Never exposes actual encrypted keys

**PUT `/api/admin/models/:modelId` & POST `/api/admin/models`**
- Encrypts new API keys before storage
- Preserves existing keys when masked value submitted
- Removes client-side helper fields before saving

#### 5. Frontend Integration

**ModelFormEditor Component:**
- Password input field for API key entry
- Visual indicator when key is configured
- Helpful placeholder text explaining fallback behavior
- Localized labels and hints

**User Experience:**
- Keys appear as `••••••••` when configured
- Clear messaging about encryption
- Optional - falls back to environment variables if not set

## Implementation Details

### Files Modified

**Server-side:**
- `server/services/EncryptionService.js` (new)
- `server/validators/modelConfigSchema.js`
- `server/utils.js`
- `server/routes/admin/models.js`

**Client-side:**
- `client/src/features/admin/components/ModelFormEditor.jsx`
- `shared/i18n/en.json`
- `shared/i18n/de.json`

### Database Schema

API keys are stored in model JSON files:

```json
{
  "id": "gpt-4",
  "provider": "openai",
  "apiKey": "base64_encrypted_key_here",
  "apiKeyEncrypted": true,
  ...
}
```

### Security Considerations

1. **Encryption at Rest**: All stored API keys encrypted with AES-256-GCM
2. **Key Derivation**: Encryption key derived from JWT_SECRET using scrypt
3. **Never Exposed**: Keys never sent to client except as masked values
4. **Backwards Compatible**: System works with unencrypted keys for migration
5. **Audit Trail**: Changes logged through normal admin API logging

### Migration Path

The implementation is fully backwards compatible:

1. **Existing Environment Variables**: Continue to work as before
2. **Plaintext Keys**: Detected and used (with warning in logs)
3. **New Keys**: Automatically encrypted when saved via admin interface

## Usage

### Admin Interface

1. Navigate to Admin → Models
2. Click on a model or create new one
3. Enter API key in the "API Key" field
4. Save the model
5. Key is automatically encrypted and stored

### Fallback Behavior

If no API key is configured for a model:
- System falls back to environment variables
- Warning displayed in admin interface
- Model still functional if provider key exists

## Testing

### Manual Testing Steps

1. **New Model with API Key**
   - Create model via admin interface
   - Add API key
   - Verify key is encrypted in JSON file
   - Test model functionality

2. **Update Existing Model**
   - Edit model with no key
   - Add API key
   - Verify encryption
   - Test model still works

3. **Key Masking**
   - Configure model with key
   - Reload edit page
   - Verify key appears as `••••••••`
   - Save without changing key
   - Verify key still works

4. **Fallback to Environment**
   - Remove model-specific key
   - Set provider environment variable
   - Verify model uses environment key

## Future Enhancements

1. **Key Rotation**: Interface for rotating API keys
2. **Key Testing**: Test connection with new key before saving
3. **Multiple Keys**: Support multiple keys per model for load balancing
4. **Key Expiration**: Track and warn about expiring keys
5. **Key Audit Log**: Detailed logging of key changes

## Related Files and Code Locations

### Encryption Logic
- `server/services/EncryptionService.js` - Main encryption service

### API Key Resolution
- `server/utils.js` - `getApiKeyForModel()` function
- `server/utils/ApiKeyVerifier.js` - Verification logic

### Admin Interface
- `server/routes/admin/models.js` - API endpoints
- `client/src/features/admin/components/ModelFormEditor.jsx` - Form UI
- `client/src/features/admin/pages/AdminModelEditPage.jsx` - Edit page

### Configuration
- `server/validators/modelConfigSchema.js` - Zod schema validation

## Security Notes

### Encryption Key Management

**Production Deployment:**
- **CRITICAL**: Set a strong JWT_SECRET in production
- Never commit JWT_SECRET to version control
- Use environment-specific secrets management
- Rotate JWT_SECRET carefully (requires re-encryption of all keys)

**Development:**
- System generates insecure default key if JWT_SECRET not set
- Warning displayed in console

### Best Practices

1. **Key Storage**: Store production keys in secure secrets management (AWS Secrets Manager, Azure Key Vault, etc.)
2. **Access Control**: Restrict admin access to authorized users only
3. **HTTPS Required**: Always use HTTPS in production to protect keys in transit
4. **Regular Rotation**: Implement regular key rotation policies
5. **Audit Logging**: Monitor and audit all API key changes

## Conclusion

This feature provides a secure, user-friendly way to configure API keys for AI models without requiring server access or environment variable management. The implementation prioritizes security through encryption while maintaining backwards compatibility and a smooth user experience.
