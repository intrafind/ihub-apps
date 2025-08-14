# Kerberos Authentication with NTLM Fallback Implementation Plan

## Executive Summary

This document outlines the implementation of Kerberos authentication with NTLM fallback for iHub Apps, providing seamless Windows domain authentication similar to Java's Waffle library. The implementation includes a two-phase approach: quick deployment using existing infrastructure and enhanced implementation with improved Windows integration.

**Business Value:**
- Modern, secure Windows domain authentication following Microsoft's 2024 deprecation of NTLM-only authentication
- Seamless single sign-on experience for Windows domain users
- Backward compatibility with legacy NTLM systems during transition periods
- Enhanced security through Kerberos protocol while maintaining fallback reliability

**Timeline:** Phase 1: 2-3 days, Phase 2: 1-2 weeks

---

## User Stories and Acceptance Criteria

### Epic 1: Core Kerberos Authentication

#### User Story 1.1: Windows Domain Authentication
**As a** Windows domain user  
**I want** to authenticate seamlessly using my domain credentials  
**So that** I don't need to manually enter login information when accessing iHub Apps

**Acceptance Criteria:**
- **Given** I am logged into a Windows domain computer
- **When** I navigate to iHub Apps in a supported browser
- **Then** I should be automatically authenticated using my domain credentials
- **And** my user information and groups should be retrieved from the domain
- **And** I should have access to resources based on my domain group memberships

#### User Story 1.2: Kerberos-First with NTLM Fallback
**As a** system administrator  
**I want** the system to attempt Kerberos authentication first and fall back to NTLM if needed  
**So that** users get the most secure authentication method available while maintaining compatibility

**Acceptance Criteria:**
- **Given** the system is configured for Negotiate authentication
- **When** a client supports Kerberos
- **Then** Kerberos should be used for authentication
- **When** a client doesn't support Kerberos or Kerberos fails
- **Then** the system should automatically fall back to NTLM
- **And** the authentication method used should be logged for auditing

#### User Story 1.3: Browser Compatibility
**As a** end user  
**I want** the authentication to work across different browsers  
**So that** I can use my preferred browser without authentication issues

**Acceptance Criteria:**
- **Given** I am using Chrome, Edge, or Internet Explorer
- **When** I access iHub Apps
- **Then** Kerberos authentication should work automatically
- **Given** I am using Firefox
- **When** I access iHub Apps after proper configuration
- **Then** Kerberos authentication should work
- **And** clear documentation should be available for Firefox configuration

### Epic 2: Enhanced Windows Integration (Phase 2)

#### User Story 2.1: Advanced Windows SSPI Integration
**As a** system administrator  
**I want** enhanced Windows integration using native SSPI  
**So that** I get better performance and more detailed user information

**Acceptance Criteria:**
- **Given** the enhanced implementation is deployed
- **When** users authenticate
- **Then** the system should use native Windows SSPI for authentication
- **And** more detailed user attributes should be available (SID, additional group information)
- **And** performance should be improved compared to the basic implementation

---

## Technical Specifications

### Phase 1: Quick Implementation (express-ntlm negotiate)

#### 1.1 Configuration Schema

```json
{
  "ntlmAuth": {
    "enabled": true,
    "type": "negotiate",
    "domain": "YOURDOMAIN.COM",
    "domainController": "dc1.yourdomain.com",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "generateJwtToken": true,
    "sessionTimeoutMinutes": 480,
    "defaultGroups": ["authenticated"],
    "options": {
      "tlsOptions": {
        "rejectUnauthorized": false
      }
    }
  }
}
```

#### 1.2 Required Changes

1. **Platform Configuration Update**
   - Update `contents/config/platform.json` to include `ntlmAuth` section
   - Change `type` from `"ntlm"` to `"negotiate"`
   - Add domain controller configuration

2. **No Code Changes Required**
   - Current `ntlmAuth.js` middleware already supports `negotiate` type
   - Current setup flow in `setup.js` already handles the configuration
   - Browser detection and fallback handled automatically by express-ntlm

#### 1.3 Browser Support Matrix

| Browser | Kerberos Support | Configuration Required | Notes |
|---------|-----------------|----------------------|--------|
| Chrome | ✅ Yes | Minimal | Automatic for intranet sites |
| Edge | ✅ Yes | Minimal | Automatic for intranet sites |
| Internet Explorer | ✅ Yes | None | Built-in support |
| Firefox | ⚠️ Limited | Manual | Requires `network.negotiate-auth.trusted-uris` |
| Safari | ❌ No | N/A | Not supported |

### Phase 2: Enhanced Implementation (node-expose-sspi)

#### 2.1 New Dependencies

```json
{
  "dependencies": {
    "node-expose-sspi": "^0.1.30"
  }
}
```

#### 2.2 Enhanced Middleware Architecture

```javascript
// server/middleware/kerberosAuth.js
import sspi from 'node-expose-sspi';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';

/**
 * Enhanced Kerberos/NTLM authentication using node-expose-sspi
 */
export class KerberosAuthenticator {
  constructor(config) {
    this.config = config;
    this.sspiPackage = sspi.sspiPackage;
  }

  async authenticate(req, res) {
    // Implementation details for SSPI integration
  }

  extractUserInfo(sspiResult) {
    // Enhanced user information extraction
  }

  resolveGroups(user) {
    // Enhanced group resolution with SID support
  }
}
```

#### 2.3 Enhanced Configuration Schema

```json
{
  "kerberosAuth": {
    "enabled": true,
    "provider": "sspi",
    "domain": "YOURDOMAIN.COM",
    "domainController": "dc1.yourdomain.com",
    "spn": "HTTP/ihub.yourdomain.com",
    "keytab": "/path/to/service.keytab",
    "debug": false,
    "features": {
      "sidResolution": true,
      "nestedGroups": true,
      "userAttributes": true,
      "tokenGroups": true
    },
    "fallback": {
      "ntlm": true,
      "anonymous": false
    },
    "security": {
      "allowDelegation": false,
      "requireMutualAuth": true,
      "clockSkewMinutes": 5
    }
  }
}
```

---

## Data Models and API Specifications

### Enhanced User Object

```javascript
{
  "id": "DOMAIN\\username",
  "name": "Display Name",
  "email": "user@domain.com",
  "groups": ["domain-users", "app-users"],
  "authenticated": true,
  "authMethod": "kerberos|ntlm",
  "provider": "kerberos-sspi",
  "domain": "YOURDOMAIN",
  "workstation": "WORKSTATION01",
  "sid": "S-1-5-21-...",
  "upn": "user@yourdomain.com",
  "tokenGroups": ["S-1-5-21-..."],
  "attributes": {
    "department": "IT",
    "title": "Software Engineer",
    "manager": "DOMAIN\\manager"
  },
  "kerberosInfo": {
    "realm": "YOURDOMAIN.COM",
    "servicePrincipal": "HTTP/ihub.yourdomain.com",
    "ticketFlags": ["FORWARDABLE", "RENEWABLE"],
    "authTime": "2025-08-13T10:00:00Z",
    "endTime": "2025-08-13T20:00:00Z"
  }
}
```

### Authentication Status Endpoint

```javascript
// GET /api/auth/kerberos/status
{
  "authMethod": "kerberos",
  "supportedMethods": ["kerberos", "ntlm"],
  "domainInfo": {
    "domain": "YOURDOMAIN.COM",
    "domainController": "dc1.yourdomain.com",
    "kerberosRealm": "YOURDOMAIN.COM"
  },
  "clientCapabilities": {
    "kerberos": true,
    "ntlm": true,
    "browser": "Chrome/118.0"
  }
}
```

---

## Security Considerations

### 1. Kerberos Security Benefits

- **Mutual Authentication**: Both client and server verify each other's identity
- **No Password Transmission**: Credentials never sent over the network
- **Time-based Security**: Tickets have limited lifetime and renewal requirements
- **Encryption**: All communication encrypted using strong cryptographic algorithms

### 2. Implementation Security

```javascript
// Security configuration
const securityConfig = {
  // Prevent credential delegation for security
  allowDelegation: false,
  
  // Require mutual authentication
  requireMutualAuth: true,
  
  // Clock skew tolerance (default: 5 minutes)
  clockSkewMinutes: 5,
  
  // Strong encryption types only
  encryptionTypes: ['AES256-CTS-HMAC-SHA1-96', 'AES128-CTS-HMAC-SHA1-96'],
  
  // Disable weak authentication methods
  disableNtlmV1: true,
  
  // Audit configuration
  auditLevel: 'detailed'
};
```

### 3. Network Security

- **Service Principal Name (SPN)**: Properly configured SPNs prevent man-in-the-middle attacks
- **Keytab Security**: Service account keytabs must be protected with appropriate file permissions
- **HTTPS Enforcement**: All authentication traffic should occur over HTTPS
- **Domain Trust**: Verify proper domain trust relationships

### 4. Fallback Security

```javascript
// Secure fallback configuration
const fallbackConfig = {
  ntlm: {
    enabled: true,
    version: 2, // NTLMv2 only
    requireSigning: true,
    requireSealing: true
  },
  anonymous: {
    enabled: false, // Disable for security
    allowedPaths: [] // No anonymous access
  }
};
```

---

## Browser Configuration Requirements

### Chrome/Edge Configuration

```javascript
// Group Policy Settings
// Computer Configuration > Administrative Templates > Google Chrome
// - Authentication server whitelist: *.yourdomain.com
// - Integrated authentication sites: *.yourdomain.com

// Registry entries for Edge
[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge]
"AuthServerWhitelist"="*.yourdomain.com"
"AuthNegotiateDelegateWhitelist"="*.yourdomain.com"
```

### Firefox Configuration

```javascript
// about:config settings
network.negotiate-auth.trusted-uris = "https://ihub.yourdomain.com"
network.negotiate-auth.delegation-uris = "https://ihub.yourdomain.com"
network.automatic-ntlm-auth.trusted-uris = "https://ihub.yourdomain.com"
```

### Internet Explorer Configuration

```javascript
// Internet Options > Security > Local Intranet > Sites
// - Automatically detect intranet network
// - Include all local (intranet) sites not listed in other zones
// - Include all sites that bypass the proxy server

// Advanced settings
// - Enable Integrated Windows Authentication
```

---

## Testing Strategy

### 1. Phase 1 Testing

#### Unit Tests
```javascript
// test/auth/kerberos.test.js
describe('Kerberos Authentication', () => {
  describe('negotiate type configuration', () => {
    it('should configure express-ntlm with negotiate type', () => {
      // Test configuration setup
    });
    
    it('should handle kerberos authentication success', () => {
      // Test kerberos auth flow
    });
    
    it('should fallback to NTLM when kerberos fails', () => {
      // Test fallback mechanism
    });
  });
});
```

#### Integration Tests
```javascript
// test/integration/domainAuth.test.js
describe('Domain Authentication Integration', () => {
  it('should authenticate domain user with kerberos', async () => {
    // Test full auth flow with mock domain
  });
  
  it('should extract user groups from domain', async () => {
    // Test group extraction and mapping
  });
  
  it('should generate JWT token after authentication', async () => {
    // Test token generation
  });
});
```

### 2. Phase 2 Testing

#### SSPI Integration Tests
```javascript
// test/auth/sspiAuth.test.js
describe('SSPI Authentication', () => {
  it('should use native SSPI for authentication', () => {
    // Test SSPI integration
  });
  
  it('should resolve user SIDs and attributes', () => {
    // Test enhanced user info
  });
  
  it('should handle nested group membership', () => {
    // Test complex group structures
  });
});
```

### 3. Browser Testing Matrix

| Test Scenario | Chrome | Edge | IE | Firefox | Expected Result |
|---------------|--------|------|----|---------| --------------- |
| Kerberos Auth | ✅ | ✅ | ✅ | ✅* | Automatic authentication |
| NTLM Fallback | ✅ | ✅ | ✅ | ✅ | Seamless fallback |
| Group Extraction | ✅ | ✅ | ✅ | ✅ | Correct groups assigned |
| Token Generation | ✅ | ✅ | ✅ | ✅ | Valid JWT created |
| Session Management | ✅ | ✅ | ✅ | ✅ | Proper session handling |

*Requires manual configuration

### 4. Load Testing

```javascript
// test/load/kerberosLoad.test.js
describe('Kerberos Load Testing', () => {
  it('should handle 100 concurrent kerberos authentications', async () => {
    // Load test with concurrent users
  });
  
  it('should maintain performance under mixed auth load', async () => {
    // Test with mixed kerberos/ntlm load
  });
});
```

---

## Performance Considerations

### 1. Phase 1 Performance

- **express-ntlm overhead**: Minimal performance impact
- **Negotiate handshake**: 2-3 round trips for Kerberos, 3-4 for NTLM fallback
- **Caching**: JWT tokens reduce subsequent authentication overhead

### 2. Phase 2 Performance Improvements

```javascript
// Performance optimizations
const performanceConfig = {
  // Connection pooling for domain controller queries
  domainControllerPool: {
    maxConnections: 10,
    keepAlive: true,
    timeout: 5000
  },
  
  // User information caching
  userCache: {
    enabled: true,
    ttlMinutes: 15,
    maxEntries: 1000
  },
  
  // Group resolution caching
  groupCache: {
    enabled: true,
    ttlMinutes: 30,
    maxEntries: 500
  }
};
```

### 3. Monitoring and Metrics

```javascript
// metrics/kerberosMetrics.js
export const kerberosMetrics = {
  authenticationAttempts: counter('kerberos_auth_attempts_total'),
  authenticationDuration: histogram('kerberos_auth_duration_seconds'),
  authenticationMethod: counter('kerberos_auth_method_total', ['method']),
  fallbackRate: gauge('kerberos_fallback_rate'),
  errorRate: gauge('kerberos_error_rate')
};
```

---

## Migration and Deployment

### Phase 1 Deployment Steps

1. **Configuration Update**
   ```bash
   # Update platform.json
   cp contents/config/platform.json contents/config/platform.json.backup
   # Update ntlmAuth.type from "ntlm" to "negotiate"
   ```

2. **Testing**
   ```bash
   # Run authentication tests
   npm run test:auth
   
   # Verify negotiate header handling
   curl -H "Authorization: Negotiate" http://localhost:3000/api/health
   ```

3. **Deployment**
   ```bash
   # Deploy with zero downtime
   npm run deploy:rolling
   ```

### Phase 2 Migration Strategy

1. **Parallel Implementation**
   - Deploy Phase 2 alongside Phase 1
   - Use feature flags to control which implementation is active
   - Gradual user migration based on testing results

2. **Rollback Strategy**
   ```javascript
   // Feature flag configuration
   const authConfig = {
     kerberosProvider: process.env.KERBEROS_PROVIDER || 'express-ntlm', // 'sspi' for Phase 2
     fallbackEnabled: true,
     rollbackThresholdErrorRate: 0.05 // 5% error rate triggers rollback
   };
   ```

3. **Data Migration**
   - No data migration required for Phase 1
   - Phase 2 may require user cache migration for enhanced attributes

---

## Documentation Requirements

### 1. Administrator Documentation

- **Installation Guide**: Step-by-step setup instructions
- **Configuration Reference**: Complete configuration options
- **Troubleshooting Guide**: Common issues and solutions
- **Security Best Practices**: Security hardening recommendations

### 2. End User Documentation

- **Browser Setup Guide**: Configuration instructions for each browser
- **FAQ**: Common questions about Kerberos authentication
- **Troubleshooting**: User-facing authentication issues

### 3. Developer Documentation

- **API Reference**: Authentication endpoints and responses
- **Integration Guide**: How to integrate with external systems
- **Testing Guide**: How to test Kerberos authentication locally

---

## Success Metrics and KPIs

### 1. Technical Metrics

- **Authentication Success Rate**: > 99.5%
- **Authentication Response Time**: < 500ms (95th percentile)
- **Fallback Rate**: < 10% of total authentications
- **Error Rate**: < 0.1%

### 2. Business Metrics

- **User Adoption**: 100% of domain users migrated within 30 days
- **Support Tickets**: < 5 authentication-related tickets per month
- **Security Incidents**: 0 authentication-related security incidents

### 3. Performance Metrics

- **Page Load Time Impact**: < 100ms increase
- **Server Resource Usage**: < 10% increase in memory usage
- **Concurrent User Support**: Support 500+ concurrent authenticated users

---

## Risk Analysis and Mitigation

### High Risk Items

1. **Domain Controller Connectivity**
   - **Risk**: Authentication failures if DC is unavailable
   - **Mitigation**: Multiple DC configuration, connection pooling, fallback mechanisms

2. **Browser Compatibility Issues**
   - **Risk**: Users unable to authenticate in unsupported browsers
   - **Mitigation**: Comprehensive browser testing, clear documentation, graceful fallback

3. **Performance Impact**
   - **Risk**: Authentication overhead impacts application performance
   - **Mitigation**: Performance testing, caching strategies, monitoring

### Medium Risk Items

1. **Configuration Complexity**
   - **Risk**: Misconfiguration leads to authentication failures
   - **Mitigation**: Validation scripts, comprehensive testing, detailed documentation

2. **Security Vulnerabilities**
   - **Risk**: Improper implementation creates security holes
   - **Mitigation**: Security review, penetration testing, regular updates

### Low Risk Items

1. **User Training Requirements**
   - **Risk**: Users don't understand new authentication flow
   - **Mitigation**: Clear documentation, communication plan, support resources

---

## Timeline and Dependencies

### Phase 1: Quick Implementation (2-3 days)

**Day 1:**
- [ ] Update platform configuration to use "negotiate" type
- [ ] Test basic Kerberos authentication flow
- [ ] Verify NTLM fallback functionality

**Day 2:**
- [ ] Browser compatibility testing
- [ ] Documentation updates
- [ ] Security review

**Day 3:**
- [ ] Production deployment
- [ ] Monitoring setup
- [ ] User communication

### Phase 2: Enhanced Implementation (1-2 weeks)

**Week 1:**
- [ ] Install and configure node-expose-sspi
- [ ] Implement enhanced middleware
- [ ] Unit testing and integration testing
- [ ] Performance benchmarking

**Week 2:**
- [ ] Security testing
- [ ] Documentation completion
- [ ] User acceptance testing
- [ ] Production rollout with feature flags

### Dependencies

1. **External Dependencies**
   - Windows domain infrastructure
   - DNS configuration for service principals
   - Certificate authority for HTTPS

2. **Internal Dependencies**
   - Current authentication system (leverage existing infrastructure)
   - JWT token service (already implemented)
   - Group mapping system (already implemented)

---

## Conclusion

This implementation plan provides a comprehensive approach to adding Kerberos authentication with NTLM fallback to iHub Apps. Phase 1 offers a quick, low-risk implementation using existing infrastructure, while Phase 2 provides enhanced functionality for organizations requiring advanced Windows integration.

The plan addresses all technical, security, and operational aspects while providing clear success criteria and risk mitigation strategies. The phased approach allows for gradual rollout and validation before full deployment.