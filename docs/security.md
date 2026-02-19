# Security Guide for iHub Apps

iHub Apps implements a comprehensive security model designed to protect user data, secure API communications, and provide flexible authentication and authorization. This guide covers security best practices for deployment, configuration, and operation.

## Table of Contents

1. [Security Architecture Overview](#security-architecture-overview)
2. [Authentication & Authorization](#authentication--authorization)
3. [API Security](#api-security)
4. [LLM Integration Security](#llm-integration-security)
5. [Data Protection](#data-protection)
6. [Network Security](#network-security)
7. [Deployment Security](#deployment-security)
8. [Operational Security](#operational-security)
9. [Security Checklist](#security-checklist)
10. [Compliance & Standards](#compliance--standards)

## Security Architecture Overview

### Core Security Principles

iHub Apps follows these security principles:

- **Defense in Depth**: Multiple layers of security controls
- **Least Privilege**: Users and services have minimal necessary permissions
- **Zero Trust**: No implicit trust, verify everything
- **Secure by Default**: Secure configurations out of the box
- **Transparency**: Clear logging and audit trails

### Security Components

```
┌─────────────────────────────────────────┐
│               Client Layer              │
├─────────────────────────────────────────┤
│            Network Security             │
│        (CORS, HTTPS, Headers)           │
├─────────────────────────────────────────┤
│         Authentication Layer            │
│     (OIDC, Local, Proxy, LDAP)          │
├─────────────────────────────────────────┤
│         Authorization Layer             │
│    (Group-based, Resource Filtering)    │
├─────────────────────────────────────────┤
│            Application Layer            │
│      (Input Validation, Rate Limiting)  │
├─────────────────────────────────────────┤
│              Data Layer                 │
│        (Encryption, Access Control)     │
├─────────────────────────────────────────┤
│            Infrastructure Layer         │
│       (Container Security, Secrets)     │
└─────────────────────────────────────────┘
```

## Authentication & Authorization

### Authentication Modes

iHub Apps supports multiple authentication modes that can be configured in `contents/config/platform.json`:

#### 1. Local Authentication (Development)
```json
{
  "auth": {
    "mode": "local"
  },
  "localAuth": {
    "enabled": true,
    "usersFile": "contents/config/users.json",
    "showDemoAccounts": false
  }
}
```

**Security Considerations:**
- Use strong passwords (minimum 12 characters)
- Enable password hashing with bcryptjs (default)
- Disable demo accounts in production
- Store user credentials securely

#### 2. OIDC Authentication (Enterprise)
```json
{
  "auth": {
    "mode": "oidc"
  },
  "oidcAuth": {
    "enabled": true,
    "allowSelfSignup": false,
    "providers": [{
      "name": "corporate-sso",
      "issuer": "https://identity.company.com",
      "clientId": "your-client-id",
      "clientSecret": "${OIDC_CLIENT_SECRET}"
    }]
  }
}
```

**Security Best Practices:**
- Always use HTTPS for OIDC endpoints
- Store client secrets as environment variables
- Disable self-signup for production
- Use short session timeouts
- Implement proper logout flows

#### 3. Proxy Authentication (Enterprise)
```json
{
  "auth": {
    "mode": "proxy"
  },
  "proxyAuth": {
    "enabled": true,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "jwksUrl": "https://auth-server.company.com/.well-known/jwks"
  }
}
```

**Security Requirements:**
- Ensure proxy strips user headers from client requests
- Validate JWT signatures using JWKS
- Use trusted reverse proxy (nginx, Apache, etc.)
- Implement proper header validation

#### 4. Anonymous Access (Limited Use)
```json
{
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  }
}
```

**Security Warnings:**
- Only enable for public demos or specific use cases
- Heavily restrict anonymous user permissions
- Monitor usage for abuse
- Consider rate limiting

### Authorization System

#### Group-Based Permissions

iHub Apps uses a hierarchical group inheritance system:

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "inherits": ["users"],
      "permissions": {
        "apps": ["*"],
        "models": ["*"],
        "prompts": ["*"],
        "adminAccess": true
      }
    },
    "users": {
      "id": "users", 
      "inherits": ["authenticated"],
      "permissions": {
        "apps": ["chat", "analysis"],
        "models": ["gpt-4", "claude-3"],
        "prompts": ["general"]
      }
    },
    "authenticated": {
      "id": "authenticated",
      "inherits": ["anonymous"],
      "permissions": {
        "apps": ["chat"],
        "models": ["gpt-3.5-turbo"]
      }
    }
  }
}
```

**Security Features:**
- Circular dependency detection
- Permission inheritance and merging
- Resource-level access control
- Wildcard and specific permissions

#### Resource Filtering

All resources are filtered based on user permissions:

```javascript
// Example: Only shows models user has access to
const userModels = filterResourcesByPermissions(
  allModels, 
  user.permissions.models
);
```

### Authentication Security

#### Session Management
```json
{
  "auth": {
    "sessionTimeoutMinutes": 480,
    "jwtSecret": "${JWT_SECRET}"
  }
}
```

**Best Practices:**
- Use strong JWT secrets (32+ characters)
- Implement session timeout
- Rotate JWT secrets regularly
- Use secure cookie settings

#### Password Security
- Bcryptjs hashing with salt rounds
- Password complexity requirements
- Account lockout policies
- Secure password reset flows

## API Security

### Request Validation

#### Content-Length Validation
```javascript
// Configurable request size limits
export function checkContentLength(limit) {
  return (req, res, next) => {
    const length = parseInt(req.headers['content-length'], 10);
    if (!Number.isNaN(length) && length > limit) {
      return res.status(413).send('Payload Too Large');
    }
    next();
  };
}
```

**Configuration:**
```json
{
  "requestBodyLimitMB": 50
}
```

#### Input Sanitization

All user inputs are validated and sanitized:
- JSON schema validation
- XSS prevention
- SQL injection protection
- Path traversal prevention

### API Authentication Middleware

#### Authentication Required
```javascript
export function authRequired(req, res, next) {
  if (!isAnonymousAccessAllowed(platformConfig)) {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }
  }
  next();
}
```

#### Resource Access Control
```javascript
export const appAccessRequired = resourceAccessRequired('app');
export const modelAccessRequired = resourceAccessRequired('model');
```

### Rate Limiting

#### Request Concurrency Control
```json
{
  "requestConcurrency": 5
}
```

**Implementation:**
- Per-user request limiting
- Global concurrency controls
- Request throttling for expensive operations
- Graceful degradation under load

## LLM Integration Security

### API Key Management

#### Secure Key Storage

**1. Encrypted Environment Variables (Recommended)**

For enhanced security, encrypt sensitive values before storing them in `.env` files:

```bash
# Generate encryption key (if not already set)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to .env file
TOKEN_ENCRYPTION_KEY=your_64_character_hex_key

# Encrypt a password or API key
node server/utils/encryptEnvValue.js "sk-your-api-key-here"

# Add encrypted value to .env
OPENAI_API_KEY=ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]
```

The system automatically decrypts encrypted values on startup.

**2. Model Configuration Storage**

API keys can also be stored encrypted in model configurations via the Admin UI.

**3. Priority Order**
```
1. Model-specific encrypted key (in config)
2. Model-specific environment variable (plain or encrypted)
3. Provider-level environment variable (plain or encrypted)
```

```javascript
export async function getApiKeyForModel(modelId) {
  const provider = model.provider;
  
  switch (provider) {
    case 'openai':
      return config.OPENAI_API_KEY;
    case 'anthropic':
      return config.ANTHROPIC_API_KEY;
    // ... other providers
  }
}
```

**Security Requirements:**
- Encrypt all sensitive API keys and passwords
- Never commit plain text secrets to version control
- Use different keys for different environments
- Rotate API keys regularly
- Keep `TOKEN_ENCRYPTION_KEY` secure and backed up

#### Environment Variable Configuration
```bash
# Production environment
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_API_KEY="AIza..."
export MISTRAL_API_KEY="..."

# Optional: Default fallback key
export DEFAULT_API_KEY="fallback-key"
```

#### API Key Validation
```javascript
class ApiKeyVerifier {
  async verifyApiKey(model, res, clientRes, language) {
    const apiKey = await getApiKeyForModel(model.id);
    
    if (!apiKey) {
      console.error(`API key not found for model: ${model.id}`);
      // Return localized error without exposing system details
      return { success: false, error };
    }
    
    return { success: true, apiKey };
  }
}
```

### Secure LLM Communication

#### Request Security
- All LLM API requests use HTTPS
- Proper certificate validation
- Request signing where available
- Timeout configuration

#### Response Handling
- Content filtering for malicious responses
- Response size limits
- Error message sanitization
- No sensitive data in logs

### Custom LLM Endpoints

For custom or local LLM endpoints:

```json
{
  "models": [{
    "id": "custom-llm",
    "provider": "local",
    "endpoint": "https://internal-llm.company.com",
    "requiresApiKey": false
  }]
}
```

**Security Considerations:**
- Use internal network isolation
- Implement proper certificate validation
- Consider VPN or private networking
- Monitor for unusual traffic patterns

## Data Protection

### User Data Security

#### Data Classification
- **Public**: App configurations, public documentation
- **Internal**: Usage analytics, system metrics
- **Confidential**: User messages, authentication data
- **Restricted**: API keys, system secrets

#### Data Encryption

##### In Transit
- All external communications use TLS 1.2+
- Internal communications encrypted in production
- Certificate validation enforced
- HSTS headers implemented

##### At Rest
- Configuration files protected by filesystem permissions
- User data stored with appropriate access controls
- Logs rotated and archived securely
- Backup encryption recommended

### File Upload Security

#### Upload Validation
```javascript
// File type and size validation
const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
const maxSize = 10 * 1024 * 1024; // 10MB

if (!allowedTypes.includes(file.mimetype)) {
  throw new Error('Invalid file type');
}
```

#### Upload Storage
- Files stored outside web root
- Virus scanning integration recommended
- Access logging for uploaded files
- Automatic cleanup of temporary files

### Conversation Security

#### Message Handling
- Messages encrypted in memory during processing
- No long-term storage of conversation content by default
- Audit logging for sensitive operations
- Automatic cleanup of inactive sessions

#### Privacy Controls
- Users can delete conversation history
- Admin cannot access user conversations by default
- Export controls for conversation data
- GDPR compliance features available

## Network Security

### CORS Configuration

#### Development Configuration
```json
{
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173"],
    "credentials": true,
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    "allowedHeaders": [
      "Content-Type",
      "Authorization", 
      "X-Requested-With"
    ]
  }
}
```

#### Production Configuration
```json
{
  "cors": {
    "origin": ["https://yourdomain.com"],
    "credentials": true,
    "maxAge": 86400,
    "preflightContinue": false
  }
}
```

**Environment Variable Support:**
```json
{
  "cors": {
    "origin": ["${ALLOWED_ORIGINS}"]
  }
}
```

```bash
# Multiple origins
export ALLOWED_ORIGINS="https://app1.company.com,https://app2.company.com"
```

### HTTPS Configuration

#### SSL/TLS Setup
```bash
# Environment variables for SSL
export SSL_CERT=/path/to/certificate.pem
export SSL_KEY=/path/to/private-key.pem
export SSL_CA=/path/to/ca-certificate.pem  # Optional
```

#### SSL Best Practices
- Use TLS 1.2 or higher
- Implement HSTS headers
- Use strong cipher suites
- Regular certificate rotation
- Monitor certificate expiration

#### Self-Signed Certificates

For internal deployments, see [SSL Certificates Guide](ssl-certificates.md):

```bash
# Secure method - import to system trust store
sudo cp internal-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates

# Alternative - Node.js specific
export NODE_EXTRA_CA_CERTS=/path/to/certificates.pem
```

### Network Isolation

#### Reverse Proxy Setup (Nginx)
```nginx
server {
    listen 443 ssl;
    server_name ihub.company.com;
    
    ssl_certificate /path/to/certificate.pem;
    ssl_certificate_key /path/to/private-key.pem;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # For proxy authentication
        proxy_set_header X-Forwarded-User $remote_user;
        proxy_set_header X-Forwarded-Groups $groups;
    }
}
```

#### Firewall Configuration
```bash
# UFW example - restrict to necessary ports
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 443/tcp    # HTTPS
sudo ufw allow from 10.0.0.0/8 to any port 3000  # Internal access only
sudo ufw enable
```

## Deployment Security

### NPM Deployment

#### Production Environment
```bash
# Set production environment
export NODE_ENV=production

# Remove development dependencies
npm ci --only=production

# Set secure file permissions
chmod 600 .env
chmod -R 644 contents/config/
chmod 755 contents/

# Run as non-root user
useradd -r -s /bin/false ihub
chown -R ihub:ihub /opt/ihub-apps
sudo -u ihub npm run start:prod
```

#### Process Management
```bash
# Using systemd (recommended)
sudo systemctl enable ihub-apps
sudo systemctl start ihub-apps

# Monitor service status
sudo systemctl status ihub-apps
```

### Docker Deployment

#### Security Features
```dockerfile
# Multi-stage build reduces attack surface
FROM node:20-alpine AS production

# Run as non-root user
RUN addgroup -S ihub && adduser -S -D -H -s /sbin/nologin -G ihub ihub
USER ihub

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Health checks
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD node /app/healthcheck.js
```

#### Docker Security Best Practices
- Use official base images
- Regular security updates
- Minimal image layers
- Non-root user execution
- Read-only filesystems where possible
- Resource limits

#### Docker Compose Production
```yaml
services:
  ihub-app:
    image: ihub-apps:latest
    volumes:
      # Configuration as read-only
      - ihub-config:/app/contents/config:ro
      - ihub-apps:/app/contents/apps:ro
      
      # Writable data volumes
      - ihub-data:/app/contents/data:rw
      - ihub-logs:/app/logs:rw
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
    logging:
      driver: 'json-file'
      options:
        max-size: '10m'
        max-file: '3'
    restart: unless-stopped
```

### Kubernetes Deployment

#### Security Context
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ihub-apps
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: ihub-apps
        image: ihub-apps:latest
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        resources:
          limits:
            cpu: 2
            memory: 2Gi
          requests:
            cpu: 500m
            memory: 512Mi
```

#### Secret Management
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ihub-secrets
type: Opaque
stringData:
  OPENAI_API_KEY: "sk-..."
  JWT_SECRET: "your-jwt-secret"
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: ihub-apps
        env:
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: ihub-secrets
              key: OPENAI_API_KEY
```

### Binary Deployment

#### Standalone Binary Security
```bash
# Download and verify checksums
wget https://releases.example.com/ihub-apps-v1.0.0-linux
wget https://releases.example.com/ihub-apps-v1.0.0-linux.sha256

# Verify integrity
sha256sum -c ihub-apps-v1.0.0-linux.sha256

# Set secure permissions
chmod 755 ihub-apps-v1.0.0-linux
chown root:root ihub-apps-v1.0.0-linux

# Run as non-root user
sudo -u ihub ./ihub-apps-v1.0.0-linux
```

## Operational Security

### Logging and Monitoring

#### Security Logging
```json
{
  "authDebug": {
    "enabled": true,
    "maskTokens": true,
    "redactPasswords": true,
    "consoleLogging": false,
    "includeRawData": false
  }
}
```

#### Log Security Features
- Automatic token and password redaction
- Structured logging format
- Configurable log levels
- Log rotation and archival
- No sensitive data in logs

#### Monitoring Checklist
- [ ] Failed authentication attempts
- [ ] Unusual access patterns
- [ ] API rate limit violations
- [ ] SSL certificate expiration
- [ ] Resource usage anomalies
- [ ] Error rate increases

### Incident Response

#### Security Event Categories
1. **Authentication Failures**: Multiple failed logins, account lockouts
2. **Authorization Violations**: Access to restricted resources
3. **Input Attacks**: XSS, SQL injection attempts  
4. **Resource Abuse**: Rate limiting violations, unusual usage
5. **System Compromise**: Unauthorized access, data breaches

#### Response Procedures
1. **Detection**: Automated alerts and monitoring
2. **Analysis**: Log review and impact assessment
3. **Containment**: Temporary restrictions or blocks
4. **Eradication**: Fix vulnerabilities, update configurations
5. **Recovery**: Restore normal operations
6. **Lessons Learned**: Update security measures

### Backup and Recovery

#### Configuration Backup
```bash
# Automated backup script
#!/bin/bash
DATE=$(date +%Y%m%d-%H%M%S)
tar -czf "backup-${DATE}.tar.gz" \
    contents/config/ \
    contents/apps/ \
    contents/models/ \
    .env

# Encrypt backup
gpg --cipher-algo AES256 --compress-algo 1 --symmetric \
    --output "backup-${DATE}.tar.gz.gpg" \
    "backup-${DATE}.tar.gz"
```

#### Recovery Testing
- Regular restore testing
- Documented recovery procedures
- RTO/RPO requirements
- Alternative deployment strategies

### Updates and Patching

#### Security Update Process
1. **Monitoring**: Subscribe to security advisories
2. **Assessment**: Evaluate impact and urgency
3. **Testing**: Test updates in staging environment
4. **Deployment**: Deploy during maintenance windows
5. **Verification**: Confirm successful update and functionality

#### Dependency Management
```bash
# Check for security vulnerabilities
npm audit

# Update dependencies
npm update

# Check for outdated packages
npm outdated
```

## Security Checklist

### Pre-Production Checklist

#### Authentication & Authorization
- [ ] Authentication mode configured (not anonymous for production)
- [ ] Strong JWT secret configured (32+ characters)
- [ ] User permissions properly configured
- [ ] Admin access restricted to necessary users
- [ ] Demo accounts disabled
- [ ] Session timeout configured appropriately

#### API Security  
- [ ] Request size limits configured
- [ ] Rate limiting enabled
- [ ] Input validation implemented
- [ ] Error messages don't leak sensitive information
- [ ] CORS origins restricted to production domains

#### Network Security
- [ ] HTTPS enabled with valid certificates
- [ ] Security headers configured
- [ ] Firewall rules configured
- [ ] Internal services not exposed publicly
- [ ] Network segmentation implemented

#### Data Protection
- [ ] API keys stored as environment variables
- [ ] No secrets in configuration files
- [ ] File upload restrictions configured
- [ ] Logs don't contain sensitive data
- [ ] Data retention policies implemented

#### Infrastructure Security
- [ ] Running as non-root user
- [ ] Minimal attack surface (remove unnecessary services)
- [ ] Resource limits configured
- [ ] Health checks implemented
- [ ] Monitoring and alerting configured

### Ongoing Security Tasks

#### Daily
- [ ] Monitor security alerts and logs
- [ ] Check service health and availability
- [ ] Review authentication failures

#### Weekly  
- [ ] Review access logs for anomalies
- [ ] Check certificate expiration dates
- [ ] Update security patches

#### Monthly
- [ ] Review user access permissions
- [ ] Audit configuration changes
- [ ] Test backup and recovery procedures
- [ ] Security training for team members

#### Quarterly
- [ ] Security assessment and penetration testing
- [ ] Update incident response procedures
- [ ] Review and update security policies
- [ ] Rotate secrets and credentials

## Compliance & Standards

### Data Privacy Compliance

#### GDPR Compliance Features
- User consent management
- Data portability (export conversations)
- Right to deletion (clear conversation history)
- Data processing transparency
- Breach notification procedures

#### Implementation
```javascript
// Example: User data deletion
async function deleteUserData(userId) {
  // Delete conversations
  await conversationService.deleteByUser(userId);
  
  // Delete user profile
  await userService.delete(userId);
  
  // Audit log
  auditLogger.log('user_data_deleted', { userId });
}
```

### Security Standards

#### ISO 27001 Alignment
- Information security management system
- Risk assessment and treatment
- Security controls implementation
- Continuous improvement process

#### SOC 2 Type II Considerations
- Security controls documentation
- Access controls and monitoring
- Data encryption and protection
- Incident response procedures
- Vendor risk management

### Audit and Compliance Tools

#### Configuration Auditing
```bash
# Check configuration security
npm run security:audit:config

# Scan for vulnerabilities  
npm audit
docker scan ihub-apps:latest

# Check dependencies
npm run security:check:deps
```

#### Compliance Reporting
- Automated compliance reports
- Access control matrices
- Security control effectiveness
- Vulnerability assessment reports

## Additional Resources

- [SSL Certificates Guide](ssl-certificates.md) - Detailed SSL/TLS configuration
- [External Authentication](external-authentication.md) - OIDC and enterprise auth setup
- [Server Configuration](server-config.md) - Production server configuration
- [JWT Authentication](jwt-authentication.md) - JWT implementation details

## Support and Contact

For security-related questions or to report security vulnerabilities:

1. **General Security Questions**: Consult this documentation and configuration guides
2. **Security Vulnerabilities**: Report through secure channels following responsible disclosure
3. **Enterprise Security**: Contact your security team for organization-specific guidance
4. **Compliance Questions**: Consult with legal and compliance teams

Remember: Security is an ongoing process, not a one-time configuration. Regular reviews, updates, and monitoring are essential for maintaining a secure deployment.