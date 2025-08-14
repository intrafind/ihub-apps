# Kerberos Authentication Testing and Troubleshooting Guide

This document provides comprehensive testing procedures and troubleshooting guidance for Kerberos authentication with NTLM fallback in iHub Apps.

## Quick Start Testing

### Phase 1: Basic Negotiate Authentication Test

1. **Update Configuration**
   ```bash
   # Backup current config
   cp contents/config/platform.json contents/config/platform.json.backup
   
   # Edit platform.json - change ntlmAuth.type from "ntlm" to "negotiate"
   ```

2. **Verify Configuration**
   ```bash
   # Check configuration is valid
   npm run config:validate
   
   # Start server
   npm run dev
   ```

3. **Test Authentication**
   ```bash
   # Test with curl (will show authentication challenge)
   curl -v http://localhost:3000/api/health
   
   # Test with negotiate header
   curl -v -H "Authorization: Negotiate" http://localhost:3000/api/health
   ```

## Comprehensive Testing Strategy

### Unit Tests

```javascript
// test/auth/kerberos.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createNtlmMiddleware, processNtlmLogin } from '../../server/middleware/ntlmAuth.js';
import configCache from '../../server/configCache.js';

describe('Kerberos Authentication', () => {
  beforeEach(() => {
    // Mock configuration
    configCache.setPlatform({
      ntlmAuth: {
        enabled: true,
        type: 'negotiate',
        domain: 'TEST.LOCAL',
        domainController: 'dc1.test.local',
        debug: true
      }
    });
  });

  afterEach(() => {
    configCache.clearCache();
  });

  describe('Configuration', () => {
    it('should create NTLM middleware with negotiate type', () => {
      const config = {
        type: 'negotiate',
        domain: 'TEST.LOCAL',
        debug: true
      };
      
      const middleware = createNtlmMiddleware(config);
      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe('function');
    });

    it('should handle missing configuration gracefully', () => {
      const middleware = createNtlmMiddleware();
      expect(middleware).toBeDefined();
    });
  });

  describe('Authentication Flow', () => {
    it('should process successful Kerberos authentication', () => {
      const mockRequest = {
        ntlm: {
          authenticated: true,
          username: 'testuser',
          domain: 'TEST',
          DisplayName: 'Test User',
          email: 'testuser@test.local',
          groups: ['TEST\\Domain Users', 'TEST\\App Users']
        }
      };

      const config = {
        type: 'negotiate',
        domain: 'TEST.LOCAL',
        defaultGroups: ['authenticated']
      };

      const result = processNtlmLogin(mockRequest, config);
      
      expect(result).toBeDefined();
      expect(result.user.id).toBe('TEST\\testuser');
      expect(result.user.authMethod).toBe('ntlm');
      expect(result.user.groups).toContain('authenticated');
      expect(result.token).toBeDefined();
    });

    it('should handle authentication failure', () => {
      const mockRequest = {
        ntlm: {
          authenticated: false,
          username: 'testuser'
        }
      };

      const config = { type: 'negotiate' };

      expect(() => {
        processNtlmLogin(mockRequest, config);
      }).toThrow('NTLM authentication required');
    });

    it('should handle missing NTLM data', () => {
      const mockRequest = {};
      const config = { type: 'negotiate' };

      expect(() => {
        processNtlmLogin(mockRequest, config);
      }).toThrow('NTLM authentication required');
    });
  });

  describe('Group Mapping', () => {
    it('should map domain groups correctly', () => {
      const mockRequest = {
        ntlm: {
          authenticated: true,
          username: 'adminuser',
          domain: 'TEST',
          groups: ['TEST\\Domain Admins', 'TEST\\Domain Users']
        }
      };

      const config = {
        type: 'negotiate',
        defaultGroups: ['authenticated']
      };

      const result = processNtlmLogin(mockRequest, config);
      
      expect(result.user.groups).toContain('authenticated');
      // Groups should be mapped according to groups.json configuration
    });
  });
});
```

### Integration Tests

```javascript
// test/integration/kerberosAuth.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../server/server.js';
import configCache from '../../server/configCache.js';

describe('Kerberos Authentication Integration', () => {
  beforeAll(async () => {
    // Setup test configuration
    configCache.setPlatform({
      auth: { mode: 'ntlm' },
      ntlmAuth: {
        enabled: true,
        type: 'negotiate',
        domain: 'TEST.LOCAL',
        debug: true
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000)); // Allow server startup
  });

  afterAll(() => {
    configCache.clearCache();
  });

  describe('Authentication Endpoints', () => {
    it('should return 401 for unauthenticated requests', async () => {
      const response = await request(app)
        .get('/api/auth/user')
        .expect(401);
      
      expect(response.headers['www-authenticate']).toMatch(/Negotiate/i);
    });

    it('should handle negotiate authentication header', async () => {
      // Note: In real tests, you would need actual Kerberos tickets
      const response = await request(app)
        .get('/api/health')
        .set('Authorization', 'Negotiate YII...')
        .expect(200);
    });

    it('should fallback to NTLM when Kerberos fails', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('Authorization', 'NTLM TlRMTVNT...')
        .expect(200);
    });
  });

  describe('User Information', () => {
    it('should extract user information from domain', async () => {
      // This would require mocking the NTLM middleware response
      const mockAuth = {
        authenticated: true,
        username: 'testuser',
        domain: 'TEST',
        DisplayName: 'Test User',
        email: 'testuser@test.local'
      };

      // Test user information extraction
    });
  });
});
```

### Load Testing

```javascript
// test/load/kerberosLoad.test.js
import { describe, it } from 'vitest';
import { performance } from 'perf_hooks';

describe('Kerberos Load Testing', () => {
  it('should handle concurrent authentication requests', async () => {
    const concurrentRequests = 50;
    const requests = [];
    
    for (let i = 0; i < concurrentRequests; i++) {
      requests.push(
        fetch('http://localhost:3000/api/health', {
          headers: {
            'Authorization': 'Negotiate ...' // Mock ticket
          }
        })
      );
    }

    const startTime = performance.now();
    const responses = await Promise.all(requests);
    const endTime = performance.now();

    const successCount = responses.filter(r => r.status === 200).length;
    const avgResponseTime = (endTime - startTime) / concurrentRequests;

    expect(successCount).toBeGreaterThanOrEqual(concurrentRequests * 0.95); // 95% success rate
    expect(avgResponseTime).toBeLessThan(1000); // Under 1 second average
  });
});
```

## Browser Testing Procedures

### Chrome/Edge Testing

1. **Verify Enterprise Policies**
   ```bash
   # Check Chrome policies (Windows)
   chrome://policy/
   
   # Look for:
   # - AuthServerWhitelist: *.yourdomain.com
   # - AuthNegotiateDelegateWhitelist: *.yourdomain.com
   ```

2. **Test Authentication Flow**
   ```javascript
   // Developer Console Test
   fetch('/api/auth/user', {
     credentials: 'include'
   }).then(response => {
     console.log('Status:', response.status);
     console.log('Headers:', [...response.headers.entries()]);
     return response.json();
   }).then(data => {
     console.log('User data:', data);
   });
   ```

3. **Verify Network Tab**
   - Open Developer Tools → Network tab
   - Look for `Authorization: Negotiate` or `Authorization: NTLM` headers
   - Verify 401 → 200 authentication flow

### Firefox Testing

1. **Configuration Check**
   ```javascript
   // about:config verification
   // Check these preferences:
   network.negotiate-auth.trusted-uris
   network.negotiate-auth.delegation-uris
   network.automatic-ntlm-auth.trusted-uris
   ```

2. **Manual Configuration Script**
   ```javascript
   // Run in Firefox console to test configuration
   const testKerberos = async () => {
     try {
       const response = await fetch('/api/health');
       console.log('Auth challenge:', response.headers.get('www-authenticate'));
       
       // Attempt with credentials
       const authResponse = await fetch('/api/auth/user', {
         credentials: 'include'
       });
       console.log('Auth result:', await authResponse.json());
     } catch (error) {
       console.error('Kerberos test failed:', error);
     }
   };
   testKerberos();
   ```

### Cross-Browser Compatibility Matrix

| Test Scenario | Chrome | Edge | IE11 | Firefox | Safari | Expected Result |
|---------------|--------|------|------|---------|--------|----------------|
| Auto-detect intranet | ✅ | ✅ | ✅ | ❌ | ❌ | Automatic auth |
| Manual config | ✅ | ✅ | ✅ | ✅ | ❌ | Successful auth |
| Kerberos first | ✅ | ✅ | ✅ | ✅ | ❌ | Kerberos used |
| NTLM fallback | ✅ | ✅ | ✅ | ✅ | ❌ | NTLM used |
| Mobile browsers | ❌ | ❌ | N/A | ❌ | ❌ | Not supported |

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Authentication Fails Completely

**Symptoms:**
- 401 Unauthorized responses
- No authentication challenge headers
- Users prompted for credentials repeatedly

**Diagnostic Steps:**
```bash
# Check server logs
tail -f logs/ihub-apps.log | grep -i "ntlm\|negotiate\|auth"

# Verify configuration
node -e "console.log(JSON.stringify(require('./contents/config/platform.json').ntlmAuth, null, 2))"

# Test express-ntlm module
npm test -- --grep "ntlm"
```

**Solutions:**
1. Verify `ntlmAuth.enabled` is `true`
2. Ensure `type` is set to `"negotiate"`
3. Check domain controller connectivity
4. Verify DNS resolution for domain controller

#### 2. Kerberos Not Working (NTLM Only)

**Symptoms:**
- Authentication works but always uses NTLM
- No Kerberos tickets being used
- `Authorization: NTLM` in request headers instead of `Negotiate`

**Diagnostic Steps:**
```bash
# Check Kerberos tickets (Windows)
klist

# Check SPN registration
setspn -L ihub-service

# Verify DNS resolution
nslookup ihub.yourdomain.com
```

**Solutions:**
1. Register proper SPN: `setspn -A HTTP/ihub.yourdomain.com ihub-service`
2. Verify DNS A and PTR records
3. Check browser intranet zone settings
4. Ensure clocks are synchronized (< 5 minutes skew)

#### 3. Group Mapping Issues

**Symptoms:**
- Users authenticate but have wrong permissions
- Groups not being extracted from domain
- Authorization errors for valid users

**Diagnostic Steps:**
```bash
# Enable auth debug mode
# Set authDebug.enabled: true in platform.json

# Check group mappings
cat contents/config/groups.json | jq '.groups[] | select(.mappings)'

# Verify user groups in domain
net user testuser /domain
```

**Solutions:**
1. Update group mappings in `groups.json`
2. Verify domain group names match mappings
3. Check `getGroups: true` in ntlmAuth config
4. Ensure proper group inheritance

#### 4. Performance Issues

**Symptoms:**
- Slow authentication responses
- Timeouts during login
- High server load during auth

**Diagnostic Steps:**
```bash
# Monitor authentication timing
time curl -H "Authorization: Negotiate" http://localhost:3000/api/health

# Check domain controller response
ping dc1.yourdomain.com
telnet dc1.yourdomain.com 389

# Monitor server resources
top -p $(pgrep -f "node.*server")
```

**Solutions:**
1. Configure connection pooling
2. Enable user/group caching
3. Use local domain controller
4. Optimize DNS resolution

### Advanced Troubleshooting

#### Network Analysis

```bash
# Capture authentication traffic (Linux)
sudo tcpdump -i any -w auth.pcap port 88 or port 389 or port 3000

# Windows equivalent
netsh trace start capture=yes provider=Microsoft-Windows-Kerberos

# Analyze with Wireshark
wireshark auth.pcap
```

#### Kerberos Ticket Analysis

```bash
# Windows - List tickets
klist

# Windows - Purge tickets for testing
klist purge

# Windows - Request new ticket
kinit username@DOMAIN.COM

# Linux - Similar commands
klist -c /tmp/krb5cc_$(id -u)
kdestroy
kinit username@DOMAIN.COM
```

#### LDAP Queries for Group Information

```bash
# Test LDAP connectivity
ldapsearch -x -H ldap://dc1.yourdomain.com -D "ihub-service@yourdomain.com" -W -b "dc=yourdomain,dc=com" "(sAMAccountName=testuser)"

# Query user groups
ldapsearch -x -H ldap://dc1.yourdomain.com -D "ihub-service@yourdomain.com" -W -b "dc=yourdomain,dc=com" "(sAMAccountName=testuser)" memberOf
```

### Logging and Monitoring

#### Enable Debug Logging

```json
{
  "ntlmAuth": {
    "debug": true
  },
  "authDebug": {
    "enabled": true,
    "maskTokens": false,
    "includeRawData": true,
    "providers": {
      "ntlm": {
        "enabled": true,
        "includeHeaders": true,
        "includeNegotiation": true
      }
    }
  }
}
```

#### Custom Monitoring Script

```javascript
// scripts/monitorAuth.js
import fs from 'fs';
import { WebSocket } from 'ws';

class AuthMonitor {
  constructor() {
    this.metrics = {
      totalRequests: 0,
      successfulAuth: 0,
      failedAuth: 0,
      kerberosAuth: 0,
      ntlmAuth: 0,
      averageResponseTime: 0
    };
  }

  async monitorLogs() {
    const logFile = 'logs/ihub-apps.log';
    const watcher = fs.watch(logFile);
    
    watcher.on('change', () => {
      // Parse new log entries and update metrics
      this.parseLogEntries();
    });
  }

  parseLogEntries() {
    // Implementation to parse auth-related log entries
    // Update metrics based on log patterns
  }

  generateReport() {
    return {
      timestamp: new Date().toISOString(),
      ...this.metrics,
      successRate: this.metrics.successfulAuth / this.metrics.totalRequests,
      kerberosRate: this.metrics.kerberosAuth / this.metrics.successfulAuth
    };
  }
}

const monitor = new AuthMonitor();
monitor.monitorLogs();

setInterval(() => {
  console.log(JSON.stringify(monitor.generateReport(), null, 2));
}, 60000); // Report every minute
```

### Health Check Implementation

```javascript
// server/routes/health/kerberosHealth.js
import express from 'express';
import { pingDomainController, validateSpn, checkClockSkew } from '../utils/kerberosUtils.js';

const router = express.Router();

router.get('/kerberos', async (req, res) => {
  const health = {
    status: 'healthy',
    checks: {},
    timestamp: new Date().toISOString()
  };

  try {
    // Check domain controller connectivity
    health.checks.domainController = await pingDomainController();
    
    // Validate SPN registration
    health.checks.spn = await validateSpn();
    
    // Check clock synchronization
    health.checks.clockSkew = await checkClockSkew();
    
    // Verify DNS resolution
    health.checks.dns = await checkDnsResolution();
    
    // Test authentication flow
    health.checks.authFlow = await testAuthFlow();

    const unhealthyChecks = Object.values(health.checks).filter(check => !check.healthy);
    if (unhealthyChecks.length > 0) {
      health.status = 'degraded';
    }

  } catch (error) {
    health.status = 'unhealthy';
    health.error = error.message;
  }

  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 207 : 503;
  res.status(statusCode).json(health);
});

export default router;
```

### Testing Checklist

#### Pre-Deployment Testing

- [ ] Configuration validation passes
- [ ] Unit tests pass (authentication logic)
- [ ] Integration tests pass (full auth flow)
- [ ] Browser compatibility verified
- [ ] Performance benchmarks meet requirements
- [ ] Security scan passes
- [ ] Load testing completed

#### Post-Deployment Testing

- [ ] Health checks returning green
- [ ] Authentication metrics normal
- [ ] Error rates below threshold
- [ ] Response times within SLA
- [ ] Log monitoring active
- [ ] User acceptance testing completed
- [ ] Rollback plan tested

#### Regression Testing

- [ ] Existing NTLM functionality preserved
- [ ] JWT token generation working
- [ ] Group mapping functioning
- [ ] Session management correct
- [ ] API authentication unchanged
- [ ] Admin functionality accessible

This comprehensive testing and troubleshooting guide ensures successful implementation and ongoing operation of Kerberos authentication with NTLM fallback in iHub Apps.