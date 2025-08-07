# iFinder JWT Key Generation Guide

This guide provides step-by-step instructions for generating RSA public-private key pairs using OpenSSL for JWT authentication with iFinder integration.

## Overview

iFinder integration requires JWT tokens signed with RS256 (RSA with SHA-256) for secure authentication. This process involves:

1. **Generating a private key** for signing JWT tokens in iHub Apps
2. **Extracting the public key** for verification in iFinder
3. **Configuring both systems** to use the key pair
4. **Testing the integration** to ensure proper authentication

## Prerequisites

- OpenSSL installed on your system
- Access to iFinder administration interface
- Administrative access to iHub Apps configuration

## Step-by-Step Key Generation

### 1. Generate RSA Private Key

Create a 2048-bit RSA private key that will be used by iHub Apps to sign JWT tokens:

```bash
openssl genpkey -algorithm RSA -out ifinder_private.pem -pkeyopt rsa_keygen_bits:2048
```

**Command breakdown:**

- `genpkey`: Generate a private key
- `-algorithm RSA`: Use RSA encryption algorithm
- `-out ifinder_private.pem`: Output file for the private key
- `-pkeyopt rsa_keygen_bits:2048`: Generate 2048-bit RSA key (recommended minimum)

**Security Note**: The private key file (`ifinder_private.pem`) must be kept secure and never shared. This key will be used to sign JWT tokens.

### 2. Extract Public Key

Extract the corresponding public key that will be configured in iFinder:

```bash
openssl pkey -in ifinder_private.pem -pubout -out ifinder_public.pem
```

**Command breakdown:**

- `pkey`: Process private key
- `-in ifinder_private.pem`: Input private key file
- `-pubout`: Output the public key
- `-out ifinder_public.pem`: Output file for the public key

### 3. Verify Key Generation

Verify that your keys were generated correctly:

```bash
# Check private key details
openssl pkey -in ifinder_private.pem -text -noout

# Check public key details
openssl pkey -in ifinder_public.pem -pubin -text -noout
```

You should see output showing RSA key details including key size (2048 bit) and the key components.

### 4. Key Format Verification

Ensure your keys are in the correct PEM format:

```bash
# Private key should start with -----BEGIN PRIVATE KEY-----
head -1 ifinder_private.pem

# Public key should start with -----BEGIN PUBLIC KEY-----
head -1 ifinder_public.pem
```

## iHub Apps Configuration

### Environment Variable Configuration

Configure iHub Apps to use the private key for JWT signing:

```bash
# Set the private key content as environment variable
export IFINDER_PRIVATE_KEY="$(cat ifinder_private.pem)"

# Alternative: Set the file path
export IFINDER_PRIVATE_KEY_FILE="/path/to/ifinder_private.pem"

# Other required iFinder configuration
export IFINDER_API_URL="https://your-ifinder-instance.com"
export IFINDER_SEARCH_PROFILE="your-default-search-profile"
```

### Platform.json Configuration

Alternatively, configure in your `contents/config/platform.json`:

```json
{
  "iFinder": {
    "baseUrl": "https://your-ifinder-instance.com",
    "defaultSearchProfile": "your-default-search-profile",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...\n-----END PRIVATE KEY-----",
    "algorithm": "RS256",
    "issuer": "ihub-apps",
    "audience": "ifinder-api",
    "defaultScope": "fa_index_read",
    "tokenExpirationSeconds": 3600
  }
}
```

**Important**: When storing the private key in JSON, replace actual newlines with `\n` escape sequences.

## iFinder Configuration

### 1. Upload Public Key to iFinder

The public key (`ifinder_public.pem`) must be configured in iFinder for JWT token verification.

### 2. Spring Security OAuth2 Resource Server Configuration

Configure iFinder's Spring Security to use the public key for JWT verification:

#### Option A: Using Public Key Location

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          public-key-location: classpath:ifinder_public.pem
```

#### Option B: Using Issuer URI (if you have a JWKS endpoint)

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://ihub-apps.example.com/issuer
```

#### Option C: Enable OAuth2 Resource Server

```yaml
intrafind:
  security:
    enable-oauth2-resource-server: true

spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          public-key-location: classpath:ifinder_public.pem
          principal-claim-name: email # Use email claim as username
```

### 3. Resource Location Options

iFinder supports various resource protocols for the public key location:

- `classpath:ifinder_public.pem` - From application classpath
- `file:/path/to/ifinder_public.pem` - From file system
- `https://example.com/keys/public.pem` - From HTTPS URL
- `base64:LS0tLS1CRUdJTi...` - Base64 encoded key content
- `text:-----BEGIN PUBLIC KEY-----...` - Inline key content

### 4. Principal Claim Configuration

Configure which JWT claim to use as the username:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          principal-claim-name: email # Options: sub, email, preferred_username, upn
```

**Important for Microsoft Entra ID**: When using Microsoft Entra ID (formerly Azure AD) as the issuer, use the `email` claim as the username to ensure proper integration with Microsoft 365.

## JWT Token Structure

The generated JWT tokens will have this structure:

```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "user.email@example.com",
    "name": "User Name",
    "email": "user.email@example.com",
    "admin": true,
    "iat": 1643723400,
    "exp": 1643727000,
    "iss": "ihub-apps",
    "aud": "ifinder-api",
    "scope": "fa_index_read"
  }
}
```

## Security Best Practices

### Key Management

1. **Secure Storage**: Store private keys in secure locations with restricted file permissions

   ```bash
   chmod 600 ifinder_private.pem
   chown app:app ifinder_private.pem
   ```

2. **Environment Variables**: Use environment variables or secure secret management for production

   ```bash
   # Never commit private keys to version control
   echo "*.pem" >> .gitignore
   ```

3. **Key Rotation**: Regularly rotate key pairs (recommended: every 6-12 months)
   ```bash
   # Generate new key pair
   openssl genpkey -algorithm RSA -out ifinder_private_new.pem -pkeyopt rsa_keygen_bits:2048
   openssl pkey -in ifinder_private_new.pem -pubout -out ifinder_public_new.pem
   ```

### Production Considerations

1. **Key Size**: Use 2048-bit minimum, 4096-bit for enhanced security

   ```bash
   openssl genpkey -algorithm RSA -out ifinder_private.pem -pkeyopt rsa_keygen_bits:4096
   ```

2. **Backup Strategy**: Maintain secure backups of key pairs
3. **Access Control**: Limit access to private keys to authorized personnel only
4. **Monitoring**: Monitor JWT authentication failures and key usage

## Testing the Integration

### 1. Test Key Pair Integrity

Verify that your public/private key pair works correctly:

```bash
# Create test data
echo "test message" > test.txt

# Sign with private key
openssl dgst -sha256 -sign ifinder_private.pem -out test.sig test.txt

# Verify with public key
openssl dgst -sha256 -verify ifinder_public.pem -signature test.sig test.txt
```

You should see "Verified OK" if the key pair is working correctly.

### 2. Test JWT Generation

Use iHub Apps' iFinder integration to verify JWT generation:

1. Authenticate as a user in iHub Apps
2. Try using any iFinder tool (e.g., search)
3. Check server logs for JWT generation messages
4. Verify iFinder receives and validates the JWT token

### 3. Test iFinder Authentication

Check iFinder logs for successful JWT token validation:

```
INFO: JWT token validation successful for user: user@example.com
INFO: User granted access to search profile: default
```

## Troubleshooting

### Common Issues

#### "JWT signature verification failed"

**Cause**: Public/private key mismatch or incorrect key format

**Solutions**:

1. Verify both keys were generated from the same source
2. Check key format (PEM with correct headers)
3. Ensure no extra characters or line breaks in configuration
4. Test key pair integrity as shown above

#### "Private key format invalid"

**Cause**: Incorrect key format or encoding

**Solutions**:

1. Regenerate keys using the exact commands provided
2. Verify key starts with `-----BEGIN PRIVATE KEY-----`
3. Check for proper line breaks in JSON configuration (`\n`)
4. Ensure no BOM or special characters in key file

#### "iFinder authentication rejected"

**Cause**: Public key not properly configured in iFinder

**Solutions**:

1. Verify public key is uploaded to correct location in iFinder
2. Check Spring Security configuration syntax
3. Ensure `principal-claim-name` matches JWT claims
4. Verify iFinder can read the public key file

#### "Token expired" errors

**Cause**: JWT token lifetime too short or clock skew

**Solutions**:

1. Increase `tokenExpirationSeconds` in configuration
2. Synchronize clocks between iHub Apps and iFinder servers
3. Check JWT `exp` claim value

### Debug Mode

Enable detailed JWT debugging in iHub Apps:

```bash
DEBUG=jwt:*,ifinder:* npm start
```

Enable Spring Security debugging in iFinder:

```yaml
logging:
  level:
    org.springframework.security: DEBUG
    org.springframework.security.oauth2: TRACE
```

### Manual Token Verification

Manually verify JWT tokens using online tools (development only):

1. Copy JWT token from iHub Apps logs
2. Paste into [jwt.io](https://jwt.io)
3. Upload public key for verification
4. Check claims and signature validation

**WARNING**: Never use online JWT debuggers with production tokens or private keys.

## Advanced Configuration

### Custom JWT Claims

Configure custom claims in iHub Apps platform configuration:

```json
{
  "iFinder": {
    "jwtClaims": {
      "department": "Engineering",
      "roles": ["user", "analyst"],
      "tenant": "company-abc"
    }
  }
}
```

### Multiple Key Pairs

For key rotation scenarios, configure multiple public keys in iFinder:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          jwk-set-uri: https://ihub-apps.example.com/.well-known/jwks.json
```

### High Availability Setup

For production deployments with multiple iHub Apps instances:

1. Use shared key storage (e.g., HashiCorp Vault, Azure Key Vault)
2. Ensure all instances use the same private key
3. Configure load balancer for JWKS endpoint if using JWK Set URI

## Related Documentation

- [iFinder Integration](iFinder-Integration.md) - Complete iFinder integration guide
- [JWT Authentication](jwt-authentication.md) - General JWT authentication configuration
- [External Authentication](external-authentication.md) - Overview of authentication methods
- [Platform Configuration](platform.md) - Platform configuration reference

## Support

For issues with JWT key generation or iFinder integration:

1. **Check Prerequisites**: Verify OpenSSL version and iFinder access
2. **Review Configurations**: Double-check all configuration files
3. **Test Step by Step**: Follow each section in order
4. **Check Logs**: Review both iHub Apps and iFinder logs
5. **Contact Support**: Provide configuration details (redact sensitive information)

---

_Last updated: July 2024_
