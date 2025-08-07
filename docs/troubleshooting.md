# Troubleshooting Guide

This comprehensive troubleshooting guide helps you diagnose and resolve common issues with iHub Apps across installation, configuration, authentication, runtime, and deployment scenarios.

## Table of Contents

1. [Installation Issues](#installation-issues)
2. [Configuration Problems](#configuration-problems)
3. [Authentication Troubles](#authentication-troubles)
4. [Runtime Errors](#runtime-errors)
5. [Performance Problems](#performance-problems)
6. [Source Handlers Issues](#source-handlers-issues)
7. [LLM Provider Problems](#llm-provider-problems)
8. [Browser/Client Issues](#browserclient-issues)
9. [Docker/Deployment Issues](#dockerdeployment-issues)
10. [Development Environment](#development-environment)

---

## Installation Issues

### Node.js Version Incompatibility

**Symptoms:**
- `npm install` fails with module compatibility errors
- Syntax errors mentioning unsupported JavaScript features
- Module import/export errors

**Solution:**
```bash
# Check Node.js version
node --version

# Required: Node.js 18.x or higher
# Install using Node Version Manager (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18
```

**Prevention:**
- Always check Node.js version requirements before installation
- Use `.nvmrc` file to lock Node.js version for consistency

### Dependency Installation Failures

**Symptoms:**
```bash
npm ERR! code EACCES
npm ERR! Error: EACCES: permission denied
```

**Solutions:**

1. **Permission Issues (Linux/macOS):**
```bash
# Fix npm permissions
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules

# Or use npm's built-in fix
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

2. **Network/Proxy Issues:**
```bash
# Clear npm cache
npm cache clean --force

# Configure proxy if behind corporate firewall
npm config set proxy http://proxy.company.com:8080
npm config set https-proxy http://proxy.company.com:8080
```

3. **Platform-specific Dependencies:**
```bash
# Rebuild native modules
npm rebuild

# Install with platform-specific flags (M1 Mac)
npm install --platform=darwin --arch=arm64
```

### Playwright Browser Installation Issues

**Symptoms:**
- Browser tests fail with "Browser not found" errors
- Playwright commands hang or timeout

**Solution:**
```bash
# Install all browsers
npx playwright install

# Install specific browser
npx playwright install chromium

# With dependencies (Linux)
npx playwright install-deps
```

**Common Environment Variables:**
```bash
# Force browser download
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=false
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
```

---

## Configuration Problems

### JSON Syntax Errors

**Symptoms:**
```
❌ Failed to load: /path/to/config.json
SyntaxError: Unexpected token } in JSON at position 123
```

**Debugging Steps:**

1. **Validate JSON Syntax:**
```bash
# Use built-in Node.js validation
node -e "console.log(JSON.parse(require('fs').readFileSync('contents/config/platform.json')))"

# Use jq for better error messages
jq . contents/config/platform.json
```

2. **Common JSON Mistakes:**
- Trailing commas: `{"key": "value",}` ❌ → `{"key": "value"}` ✅
- Unquoted keys: `{key: "value"}` ❌ → `{"key": "value"}` ✅
- Single quotes: `{'key': 'value'}` ❌ → `{"key": "value"}` ✅
- Missing commas: `{"a": 1 "b": 2}` ❌ → `{"a": 1, "b": 2}` ✅

### Schema Validation Errors

**Symptoms:**
```
⚠️  Invalid source configuration for source-id: 
[
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": ["name"],
    "message": "Required"
  }
]
```

**Solutions:**

1. **App Configuration Errors:**
```json
// ❌ Missing required fields
{
  "id": "my-app"
  // Missing name, description, color, icon, system, tokenLimit
}

// ✅ Minimum valid configuration
{
  "id": "my-app",
  "name": {"en": "My App"},
  "description": {"en": "App description"},
  "color": "#3B82F6",
  "icon": "MessageSquare",
  "system": {"en": "You are a helpful assistant"},
  "tokenLimit": 4000
}
```

2. **Model Configuration Errors:**
```json
// ❌ Invalid language code
{
  "name": {
    "english": "GPT-4"  // Should be "en"
  }
}

// ✅ Correct language codes
{
  "name": {
    "en": "GPT-4",
    "de": "GPT-4",
    "es": "GPT-4"
  }
}
```

3. **Source Configuration Errors:**
```json
// ❌ Missing required fields
{
  "id": "my-source"
  // Missing name, type, handler
}

// ✅ Complete source configuration
{
  "id": "my-source",
  "name": "My Source",
  "type": "static",
  "handler": "staticText",
  "config": {
    "content": "Source content here"
  },
  "enabled": true
}
```

### Environment Variable Issues

**Symptoms:**
- Server starts but features don't work
- API calls fail with authentication errors
- Configuration values show as `${UNDEFINED_VAR}`

**Debugging Steps:**

1. **Check Environment Variables:**
```bash
# List all environment variables
printenv | grep -E "(API_KEY|SECRET|TOKEN)"

# Check specific variables
echo "OpenAI Key: ${OPENAI_API_KEY:0:10}..." # Shows first 10 characters
echo "Anthropic Key: ${ANTHROPIC_API_KEY:0:10}..."
```

2. **Common Missing Variables:**
```bash
# Required for LLM providers
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_AI_API_KEY="AI..."

# Required for authentication
export JWT_SECRET="your-secret-key"

# Optional but recommended
export REQUEST_TIMEOUT="60000"
export CORS_ORIGIN="https://yourdomain.com"
```

3. **Environment File Loading:**
```bash
# Check if .env file exists and is readable
ls -la .env
cat .env | grep -v "^#" | grep -v "^$"

# Verify environment loading in Node.js
node -e "require('dotenv').config(); console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);"
```

---

## Authentication Troubles

### Login Failures

**Symptoms:**
- Users cannot log in despite correct credentials
- "Invalid credentials" errors for valid users
- Login form redirects back to login page

**Debugging Steps:**

1. **Check Authentication Mode:**
```bash
# Verify auth configuration in platform.json
jq '.auth.authMode' contents/config/platform.json
```

2. **Local Authentication Issues:**
```bash
# Check users configuration
jq '.users | keys' contents/config/users.json

# Verify password hashes exist
jq '.users[].passwordHash' contents/config/users.json
```

**Common Solutions:**

- **Password Hash Missing:** Run password rehashing utility:
```bash
cd server
node utils/rehashPasswords.js
```

- **Wrong Auth Mode:** Update `platform.json`:
```json
{
  "auth": {
    "authMode": "local",  // or "proxy", "oidc"
    "authMethods": {
      "local": {
        "enabled": true
      }
    }
  }
}
```

### Permission Denied (403) Errors

**Symptoms:**
- Users can log in but get 403 errors accessing resources
- Admin pages show "Insufficient permissions"
- API endpoints return forbidden errors

**Debugging Steps:**

1. **Check User Groups:**
```bash
# Verify user group assignments in users.json
jq '.users."username".groups' contents/config/users.json

# Check group permissions in groups.json
jq '.groups."admin".permissions' contents/config/groups.json
```

2. **Verify Group Inheritance:**
```bash
# Check inheritance chain
jq '.groups."admin".inherits' contents/config/groups.json
```

**Solutions:**

1. **Add User to Admin Group:**
```json
// In contents/config/users.json
{
  "users": {
    "username": {
      "groups": ["admin", "users"]  // Add admin group
    }
  }
}
```

2. **Fix Group Permissions:**
```json
// In contents/config/groups.json
{
  "groups": {
    "admin": {
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true  // Required for admin pages
      }
    }
  }
}
```

### Anonymous Authentication Issues

**Symptoms:**
- Anonymous users get 401 errors unexpectedly
- Anonymous access works inconsistently

**Solution:**
```json
// In contents/config/platform.json
{
  "auth": {
    "anonymousAuth": {
      "enabled": true,
      "defaultGroups": ["anonymous"]
    }
  }
}
```

### OIDC/SSO Authentication Problems

**Symptoms:**
- OIDC redirect loops
- "Invalid state" errors
- Users cannot complete SSO flow

**Debugging Steps:**

1. **Check OIDC Configuration:**
```json
// In contents/config/platform.json
{
  "auth": {
    "authMode": "oidc",
    "authMethods": {
      "oidc": {
        "enabled": true,
        "providers": [{
          "id": "azure",
          "name": "Azure AD",
          "issuer": "https://login.microsoftonline.com/tenant-id/v2.0",
          "clientId": "your-client-id",
          "clientSecret": "${OIDC_CLIENT_SECRET}",
          "scope": "openid profile email"
        }]
      }
    }
  }
}
```

2. **Verify Environment Variables:**
```bash
echo "OIDC Secret: ${OIDC_CLIENT_SECRET:0:10}..."
```

**Common Issues:**
- **Wrong Redirect URI:** Must match exactly in OIDC provider settings
- **Certificate Issues:** OIDC requires HTTPS in production
- **Scope Problems:** Ensure required scopes are configured

---

## Runtime Errors

### Server Startup Failures

**Symptoms:**
- Server exits immediately after starting
- Port already in use errors
- Module loading errors

**Debugging Steps:**

1. **Check Port Availability:**
```bash
# Check if port 3000 is in use
lsof -i :3000
netstat -tulpn | grep :3000

# Kill process using port
kill $(lsof -t -i:3000)
```

2. **Verify Server Configuration:**
```bash
# Test server startup with timeout
timeout 10s node server/server.js || echo "Server startup check completed"

# Check for syntax errors
node --check server/server.js
```

3. **Check File Permissions:**
```bash
# Verify contents directory is readable
ls -la contents/
chmod -R 755 contents/
```

**Common Solutions:**

- **Port Conflicts:** Change port in environment:
```bash
export PORT=3001
```

- **Missing Contents Directory:**
```bash
mkdir -p contents/{config,apps,models,pages,prompts,sources}
```

- **Permission Issues:**
```bash
chmod +x server/server.js
chown -R $USER:$USER contents/
```

### Configuration Cache Failures

**Symptoms:**
```
❌ Failed to initialize configuration cache: Error message
⚠️  Server will continue with file-based configuration loading
```

**Debugging Steps:**

1. **Check Configuration Files:**
```bash
# Verify all required config files exist
ls -la contents/config/
find contents/config/ -name "*.json" -exec echo "Checking: {}" \; -exec jq . {} \;
```

2. **Check File Permissions:**
```bash
# Ensure config files are readable
chmod 644 contents/config/*.json
```

**Solution:**
- Configuration cache failures are not fatal
- Server continues with direct file loading
- Fix underlying configuration issues to restore caching

### Chat/LLM Request Failures

**Symptoms:**
- Chat responses fail with timeout errors
- "Model not available" errors
- Streaming responses cut off abruptly

**Debugging Steps:**

1. **Check API Keys:**
```bash
# Test OpenAI connection
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://api.openai.com/v1/models

# Test Anthropic connection
curl -H "x-api-key: $ANTHROPIC_API_KEY" \
     https://api.anthropic.com/v1/messages
```

2. **Check Network Connectivity:**
```bash
# Test DNS resolution
nslookup api.openai.com
ping -c 3 api.openai.com

# Test proxy settings
curl -v https://api.openai.com/v1/models
```

**Common Solutions:**

- **API Key Issues:** Verify keys are valid and have sufficient credits
- **Rate Limiting:** Implement exponential backoff and retry logic
- **Timeout Issues:** Increase `REQUEST_TIMEOUT` environment variable
- **Proxy Issues:** Configure proxy settings in environment

---

## Performance Problems

### Slow Response Times

**Symptoms:**
- Chat responses take > 30 seconds to start
- API endpoints respond slowly
- UI becomes unresponsive

**Debugging Steps:**

1. **Check System Resources:**
```bash
# Monitor system performance
htop
iostat -x 1
free -h

# Check Node.js process
ps aux | grep node
```

2. **Check Configuration Cache:**
```bash
# Verify cache is working (should see cache hit messages)
grep "cache" server/logs/*.log
```

**Solutions:**

1. **Enable Configuration Caching:**
- Ensure configuration files are valid JSON
- Check file permissions for cache directory

2. **Optimize Request Handling:**
```bash
# Increase worker processes
export WORKERS=4

# Adjust request timeout
export REQUEST_TIMEOUT=30000
```

3. **Database/Storage Optimization:**
- Clean up old conversation data
- Archive unused configuration files

### Memory Issues

**Symptoms:**
- Node.js process crashes with OOM errors
- System becomes unresponsive
- Gradual memory increase over time

**Debugging Steps:**

1. **Monitor Memory Usage:**
```bash
# Check Node.js memory usage
node -e "console.log(process.memoryUsage())"

# Monitor over time
watch -n 5 "ps aux | grep node | grep -v grep"
```

2. **Check for Memory Leaks:**
```bash
# Look for unclosed connections
lsof -p $(pgrep node) | grep -i tcp
```

**Solutions:**

- **Increase Memory Limit:**
```bash
export NODE_OPTIONS="--max-old-space-size=4096"
```

- **Monitor for Leaks:** Use heap snapshots for detailed analysis
- **Restart Schedule:** Implement automatic restarts for production

---

## Source Handlers Issues

### Source Not Working

**Symptoms:**
- Sources don't appear in applications
- "Source reference not found" warnings
- Empty source content in chat responses

**Debugging Steps:**

1. **Check Source Configuration:**
```bash
# Verify source exists and is enabled
jq '.sources[] | select(.enabled == true)' contents/config/sources.json

# Check source validation
grep "Invalid source configuration" server/logs/*.log
```

2. **Test Source Handler:**
```bash
# Check if handler files exist
ls -la server/sources/handlers/

# Test specific handler
node -e "
const handler = require('./server/sources/handlers/staticText.js');
console.log('Handler loaded:', typeof handler.execute);
"
```

**Common Issues:**

1. **Source Disabled:**
```json
// Enable source in sources.json
{
  "sources": [{
    "id": "my-source",
    "enabled": true  // Make sure this is true
  }]
}
```

2. **Handler Missing:**
- Ensure handler file exists in `server/sources/handlers/`
- Check handler exports proper `execute` function

3. **Configuration Errors:**
```json
// Ensure all required fields are present
{
  "id": "my-source",
  "name": "My Source",
  "type": "static",
  "handler": "staticText",  // Must match handler filename
  "config": {},             // Handler-specific config
  "enabled": true
}
```

### Handler Execution Errors

**Symptoms:**
- Handler throws exceptions during execution
- Partial or malformed source content
- Handler timeouts

**Debugging Steps:**

1. **Check Handler Logs:**
```bash
# Look for handler-specific errors
grep "Handler execution error" server/logs/*.log
grep "Source.*failed" server/logs/*.log
```

2. **Test Handler Manually:**
```javascript
// Create test script: test-handler.js
const handler = require('./server/sources/handlers/yourHandler.js');

handler.execute({
  // your test config
}).then(result => {
  console.log('Handler result:', result);
}).catch(error => {
  console.error('Handler error:', error);
});
```

**Solutions:**
- Implement proper error handling in custom handlers
- Add timeout protection for external API calls
- Validate handler configuration before execution

---

## LLM Provider Problems

### API Key Issues

**Symptoms:**
- 401 Unauthorized responses from LLM APIs
- "Invalid API key" errors
- Authentication failures in provider-specific adapters

**Debugging Steps:**

1. **Verify API Keys Format:**
```bash
# OpenAI keys start with 'sk-'
echo "${OPENAI_API_KEY:0:3}"  # Should show 'sk-'

# Anthropic keys start with 'sk-ant-'
echo "${ANTHROPIC_API_KEY:0:7}"  # Should show 'sk-ant-'

# Google AI keys start with 'AI'
echo "${GOOGLE_AI_API_KEY:0:2}"  # Should show 'AI'
```

2. **Test API Keys:**
```bash
# Test OpenAI
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://api.openai.com/v1/models | jq '.data[0].id'

# Test Anthropic
curl -X POST https://api.anthropic.com/v1/messages \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "Content-Type: application/json" \
     -H "anthropic-version: 2023-06-01" \
     -d '{"model":"claude-3-haiku-20240307","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```

**Solutions:**
- Regenerate API keys from provider dashboards
- Verify keys have sufficient credits/usage limits
- Check API key scopes and permissions

### Rate Limiting Issues

**Symptoms:**
- 429 "Too Many Requests" errors
- Requests fail during high usage periods
- Intermittent API failures

**Debugging:**
```bash
# Check for rate limit errors in logs
grep -i "rate.*limit\|429\|quota" server/logs/*.log
```

**Solutions:**

1. **Implement Rate Limiting:**
```javascript
// Add to model configuration
{
  "rateLimits": {
    "requestsPerMinute": 60,
    "tokensPerMinute": 10000
  }
}
```

2. **Add Retry Logic:**
- Implement exponential backoff
- Queue requests during rate limit periods
- Use multiple API keys for higher limits

### Model Availability Issues

**Symptoms:**
- "Model not found" errors
- Requests fail for specific models
- Models show as unavailable in UI

**Debugging Steps:**

1. **Check Model Configuration:**
```bash
# Verify model exists in models.json
jq '.models[] | select(.id == "problematic-model")' contents/config/models.json
```

2. **Test Model Availability:**
```bash
# Check available models via API
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://api.openai.com/v1/models | jq '.data[] | .id' | grep "gpt-4"
```

**Solutions:**
- Update model IDs to match provider's current offerings
- Remove deprecated models from configuration
- Check model access permissions in provider account

---

## Browser/Client Issues

### JavaScript Loading Errors

**Symptoms:**
- Blank white screen on load
- Console errors about missing modules
- React components fail to render

**Debugging Steps:**

1. **Check Browser Console:**
```javascript
// Open browser console (F12) and look for:
// - Module loading errors
// - Network request failures
// - React/JavaScript runtime errors
```

2. **Verify Asset Loading:**
```bash
# Check if assets are built
ls -la client/dist/

# Verify Vite build process
cd client && npm run build
```

**Solutions:**

1. **Clear Browser Cache:**
- Hard refresh: Ctrl+Shift+R (Chrome/Firefox)
- Clear application data in DevTools
- Disable browser cache during development

2. **Rebuild Client Assets:**
```bash
cd client
rm -rf dist/ node_modules/
npm install
npm run build
```

### CORS Issues

**Symptoms:**
- API requests fail with CORS errors
- "Access-Control-Allow-Origin" errors in browser console
- Requests work in Postman but fail in browser

**Debugging:**
```javascript
// Check browser console for CORS errors:
// "Access to fetch at 'http://...' has been blocked by CORS policy"
```

**Solutions:**

1. **Configure CORS Origins:**
```json
// In contents/config/platform.json
{
  "cors": {
    "origin": [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://yourdomain.com"
    ]
  }
}
```

2. **Environment-based Origins:**
```bash
# Set allowed origins via environment
export ALLOWED_ORIGINS="https://app.yourdomain.com,https://admin.yourdomain.com"
```

### React Component Rendering Issues

**Symptoms:**
- Dynamic page components fail to load
- JSX compilation errors
- Babel transformation failures

**Debugging Steps:**

1. **Check Component Syntax:**
```jsx
// Ensure proper UserComponent structure
function UserComponent(props) {
  const { React, useState, useEffect, t, navigate, user } = props;
  
  return <div>Component content</div>;
}
// No export statement needed
```

2. **Check Babel Loading:**
```javascript
// Browser console should show Babel loaded successfully
// Look for errors in network tab for Babel CDN requests
```

**Solutions:**
- Fix JSX syntax errors in component files
- Ensure component follows required naming convention
- Check Babel CDN availability and fallbacks

---

## Docker/Deployment Issues

### Container Build Failures

**Symptoms:**
- Docker build fails with dependency errors
- Out of disk space during build
- Network timeouts during package installation

**Debugging Steps:**

1. **Build with Verbose Output:**
```bash
docker build --no-cache --progress=plain -t ihub-apps .
```

2. **Check Docker Resources:**
```bash
# Check available disk space
docker system df
docker system prune -f  # Clean up unused resources

# Check memory limits
docker info | grep -i memory
```

**Solutions:**

1. **Dependency Issues:**
```bash
# Clean build cache
docker builder prune -f

# Build with specific Node.js version
docker build --build-arg NODE_VERSION=18 -t ihub-apps .
```

2. **Resource Issues:**
```bash
# Increase Docker memory limit (Docker Desktop)
# Settings → Resources → Memory → 4GB+

# Clean up Docker system
docker system prune -af
```

### Container Runtime Issues

**Symptoms:**
- Container starts but immediately exits
- Health checks fail
- Container cannot access external services

**Debugging Steps:**

1. **Check Container Logs:**
```bash
# View container logs
docker logs ihub-apps-server

# Follow logs in real-time
docker logs -f ihub-apps-server

# Check exit code
docker ps -a | grep ihub-apps
```

2. **Test Container Environment:**
```bash
# Execute shell in running container
docker exec -it ihub-apps-server /bin/bash

# Check environment variables
docker exec ihub-apps-server printenv

# Test network connectivity
docker exec ihub-apps-server curl -I https://api.openai.com
```

**Solutions:**

1. **Environment Variable Issues:**
```bash
# Ensure .env file is properly loaded
docker run --env-file .env ihub-apps

# Check variable format
grep -v '^#' .env | grep -v '^$'
```

2. **Network Issues:**
```bash
# Check Docker network
docker network ls
docker network inspect bridge

# Test DNS resolution
docker exec ihub-apps-server nslookup api.openai.com
```

### Docker Compose Issues

**Symptoms:**
- Services fail to start in correct order
- Service communication failures
- Volume mounting problems

**Debugging Steps:**

1. **Check Service Status:**
```bash
# View all service status
docker-compose ps

# Check specific service logs
docker-compose logs server
docker-compose logs -f server  # Follow logs
```

2. **Validate Compose File:**
```bash
# Validate docker-compose.yml syntax
docker-compose config

# Validate specific environment
docker-compose -f docker-compose.prod.yml config
```

**Solutions:**

1. **Service Dependencies:**
```yaml
# Ensure proper service dependencies in docker-compose.yml
services:
  server:
    depends_on:
      - database  # If using database
```

2. **Volume Issues:**
```bash
# Check volume mounts
docker-compose exec server ls -la /app/contents/

# Fix volume permissions
docker-compose exec server chown -R node:node /app/contents/
```

---

## Development Environment

### Hot Reload Not Working

**Symptoms:**
- Changes to client code don't reflect in browser
- Vite dev server not detecting file changes
- Server doesn't restart on file changes

**Debugging Steps:**

1. **Check Vite Development Server:**
```bash
# Verify Vite is running
curl http://localhost:5173

# Check Vite configuration
cat client/vite.config.js
```

2. **Check File Watcher Limits (Linux):**
```bash
# Check current limit
cat /proc/sys/fs/inotify/max_user_watches

# Increase limit
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

**Solutions:**

1. **Restart Development Environment:**
```bash
# Stop all development processes
npm run stop

# Clear caches and restart
rm -rf client/node_modules/.vite/
npm run dev
```

2. **Check Port Conflicts:**
```bash
# Ensure ports 3000 and 5173 are available
lsof -i :3000
lsof -i :5173
```

### ESLint/Formatting Issues

**Symptoms:**
- Code fails linting checks
- Inconsistent code formatting
- Pre-commit hooks fail

**Debugging Steps:**

1. **Check ESLint Configuration:**
```bash
# Test ESLint on specific file
npx eslint client/src/App.jsx

# Check ESLint configuration
cat eslint.config.js
```

2. **Check Prettier Configuration:**
```bash
# Test Prettier formatting
npx prettier --check client/src/App.jsx

# Show what would be formatted
npx prettier --list-different .
```

**Solutions:**

1. **Fix Linting Issues:**
```bash
# Auto-fix ESLint issues
npm run lint:fix

# Auto-format with Prettier
npm run format:fix
```

2. **Update Configuration:**
```bash
# Regenerate lock files
rm -rf node_modules package-lock.json
npm install

# Update ESLint and Prettier
npm update eslint prettier
```

### Test Failures

**Symptoms:**
- Unit tests fail after code changes
- Integration tests timeout
- Test coverage drops unexpectedly

**Debugging Steps:**

1. **Run Specific Tests:**
```bash
# Test specific LLM adapter
npm run test:openai

# Test authentication
cd server && node tests/authentication-security.test.js
```

2. **Check Test Configuration:**
```bash
# Verify test environment variables
cat .env.test

# Check test database/config state
ls -la contents/test/
```

**Solutions:**

- Update test fixtures after configuration changes
- Ensure test environment variables are set
- Reset test database/configuration between runs

---

## Prevention and Best Practices

### Regular Maintenance

1. **Monitor Logs:**
```bash
# Set up log rotation
logrotate /path/to/logs/server.log

# Monitor error patterns
tail -f server/logs/error.log | grep -E "(ERROR|FATAL)"
```

2. **Health Checks:**
```bash
# Automated health check script
#!/bin/bash
curl -f http://localhost:3000/api/health || exit 1
curl -f http://localhost:3000/api/status || exit 1
```

3. **Configuration Validation:**
```bash
# Regular configuration validation
npm run validate:config

# Automated backup before changes
cp -r contents/ "contents-backup-$(date +%Y%m%d)"
```

### Monitoring and Alerting

1. **System Metrics:**
- CPU and memory usage trends
- API response times
- Error rate thresholds
- Disk space monitoring

2. **Application Metrics:**
- Configuration load times
- Authentication success rates
- LLM API response times
- Cache hit ratios

3. **Log Analysis:**
- Error pattern detection
- Performance regression identification
- Security event monitoring
- Usage analytics

### Documentation Updates

- Keep troubleshooting guide updated with new issues
- Document environment-specific configurations
- Maintain runbooks for common operational tasks
- Update error message catalog

---

## Getting Help

### Debug Information Collection

When reporting issues, include:

1. **Environment Information:**
```bash
# System information
uname -a
node --version
npm --version
docker --version

# Application version
git rev-parse HEAD
```

2. **Configuration Samples:**
```bash
# Sanitized configuration (remove secrets)
jq 'del(.auth.jwt.secret, .auth.oidc.clientSecret)' contents/config/platform.json
```

3. **Error Logs:**
```bash
# Recent error logs
tail -100 server/logs/error.log

# Specific error context
grep -A 10 -B 10 "error-message" server/logs/server.log
```

### Support Channels

- **Issues**: GitHub repository issues section
- **Documentation**: Check docs/ directory for specific topics
- **Community**: Discussion forums and community channels
- **Enterprise**: Dedicated support channels for enterprise installations

### Creating Effective Bug Reports

1. **Clear Problem Statement**: Describe what you expected vs. what happened
2. **Reproducible Steps**: Exact sequence to reproduce the issue
3. **Environment Details**: OS, Node.js version, deployment method
4. **Error Messages**: Complete error messages and stack traces
5. **Configuration**: Relevant configuration snippets (sanitized)
6. **Workarounds**: Any temporary solutions discovered

This troubleshooting guide covers the most common issues encountered with iHub Apps. Regular updates based on user feedback and new deployment scenarios will keep it current and useful for the community.

---

## Related Documentation

For more specific guidance, consult these related documentation files:

- [Installation Guide](INSTALLATION.md) - Detailed installation procedures
- [Docker Quick Reference](DOCKER-QUICK-REFERENCE.md) - Docker-specific troubleshooting
- [External Authentication](external-authentication.md) - Authentication setup and troubleshooting
- [Security Guide](security.md) - Security configuration and common issues
- [Server Configuration](server-config.md) - Production server setup
- [Configuration Validation](configuration-validation.md) - Config file validation
- [Developer Onboarding](developer-onboarding.md) - Development environment setup
- [Architecture Overview](architecture.md) - System architecture understanding