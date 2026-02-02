# Migration Guide: Encryption Key Persistence

## What Changed

**Version:** 4.2.1+
**Date:** February 2026

### Summary

Starting with version 4.2.1, iHub Apps now **persists the encryption key** to disk to maintain API key compatibility across server restarts.

### Background

**Before (v4.2.0 and earlier):**

- If `TOKEN_ENCRYPTION_KEY` was not set in `.env`, a new random encryption key was generated on each server start
- Provider API keys encrypted in one session could not be decrypted after restart
- This caused the issue: "Provider specific key not used after restart"

**After (v4.2.1+):**

- Encryption key is automatically persisted to `contents/.encryption-key`
- The same key is reused across server restarts
- Provider API keys remain functional after restart

## Impact on Existing Installations

### Scenario 1: Fresh Installation

✅ **No action required**

- Encryption key will be auto-generated and persisted on first start
- Everything works out of the box

### Scenario 2: Upgrade from v4.2.0 or Earlier

⚠️ **Action Required: Re-enter API Keys**

After upgrading:

1. **Server starts with a NEW encryption key**
   - A new key is generated and persisted to `contents/.encryption-key`
   - This is different from the random keys used in previous sessions

2. **Existing encrypted API keys cannot be decrypted**
   - Keys encrypted with old random keys are unrecoverable
   - Decryption fails silently and falls back to environment variables

3. **Solution: Re-enter API keys via admin panel**
   - Log in to the admin panel
   - Navigate to Providers section
   - Re-enter API keys for each provider
   - Keys will be encrypted with the new persistent key
   - Keys will now work correctly after server restarts

### Scenario 3: Production with TOKEN_ENCRYPTION_KEY Set

✅ **No action required**

- Your existing `TOKEN_ENCRYPTION_KEY` environment variable continues to work
- No change in behavior
- Encryption key is not persisted to file when env var is set

## For New Deployments

### Development/Local

No configuration needed:

```bash
# Just start the server
npm run dev
```

The encryption key is auto-generated and saved to `contents/.encryption-key`.

### Production - Single Instance

**Option 1: Use persisted key file (recommended)**

```bash
# Start server - key is auto-generated
npm start

# Backup the key file
cp contents/.encryption-key /secure/backup/location/.encryption-key
```

**Important:**

- Include `contents/.encryption-key` in your backup strategy
- Ensure `contents/` directory persists across deployments
- Never commit the key file to version control

**Option 2: Use environment variable**

```bash
# Generate a key
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Add to .env
echo "TOKEN_ENCRYPTION_KEY=$KEY" >> .env

# Start server
npm start
```

### Production - Multiple Instances (Load Balanced)

**You MUST use environment variable:**

```bash
# Generate ONE key for all instances
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Set on all instances
export TOKEN_ENCRYPTION_KEY=$KEY

# Start all instances
# All instances will use the same encryption key
```

**Why:** If each instance generates its own key, they won't be able to decrypt data encrypted by other instances.

### Docker Deployments

**docker-compose.yml:**

```yaml
version: '3.8'
services:
  ihub-apps:
    image: ihub-apps:latest
    environment:
      - TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}
    volumes:
      - ./contents:/app/contents # If using file-based key
```

**With persisted key file:**

```bash
# First run - generates key
docker-compose up -d

# Backup the key
docker cp ihub-apps:/app/contents/.encryption-key ./backup/

# Subsequent runs - key file persists via volume
docker-compose up -d
```

**With environment variable:**

```bash
# Set in .env file
echo "TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env

# Start
docker-compose up -d
```

### Kubernetes Deployments

**Use Secrets:**

```yaml
# Create secret
apiVersion: v1
kind: Secret
metadata:
  name: ihub-encryption-key
type: Opaque
stringData:
  token-encryption-key: 'your-64-character-hex-key-here'

---
# Use in deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: ihub-apps
          image: ihub-apps:latest
          env:
            - name: TOKEN_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: ihub-encryption-key
                  key: token-encryption-key
```

## Troubleshooting Migration Issues

### Issue: "Failed to decrypt string. The encryption key may have changed."

**Cause:** Trying to decrypt data encrypted with a different key.

**Solution:**

1. Check server logs for which key source is being used
2. If key was recently changed, restore the old key or re-enter data
3. Re-enter provider API keys via admin panel

### Issue: API Keys Lost After Upgrade

**Expected behavior** - see Scenario 2 above.

**Solution:**

1. Log in to admin panel
2. Navigate to Providers
3. Re-enter API keys for each provider
4. Verify functionality

### Issue: Different Instances Using Different Keys

**Symptoms:**

- API key works on one instance but not others
- Intermittent failures in load-balanced setup

**Solution:**

1. Generate ONE encryption key
2. Set `TOKEN_ENCRYPTION_KEY` environment variable on ALL instances
3. Restart all instances
4. Re-enter API keys if needed

## FAQ

### Q: Will this affect my users?

**A:** No. User-facing functionality is not affected. Only administrators need to re-enter provider API keys after upgrade.

### Q: What if I lose the encryption key?

**A:** You'll need to re-enter all encrypted data:

- Provider API keys (via admin panel)
- User OAuth tokens (users will need to re-authenticate)

This is why backing up the key is important for production deployments.

### Q: Can I use the same key across environments?

**A:** Not recommended. Use different keys for:

- Development
- Staging
- Production

This limits the impact if a key is compromised.

### Q: How do I rotate the encryption key?

**A:** See `docs/encryption-key-management.md` for key rotation procedures.

### Q: Is the old random key stored anywhere?

**A:** No. The random keys generated in v4.2.0 and earlier were never persisted. They were lost on server restart, which is why this fix was needed.

## Support

If you encounter issues during migration:

1. Check server logs for encryption-related messages
2. Review `docs/encryption-key-management.md` for detailed documentation
3. Open a GitHub issue with:
   - Your deployment scenario
   - Server logs (redact any sensitive info)
   - Steps you've taken

## Related Documentation

- [Encryption Key Management](docs/encryption-key-management.md) - Complete guide
- [Security Best Practices](docs/security.md) - Security guidelines
- [Admin Guide](docs/admin-guide.md) - Admin panel usage
