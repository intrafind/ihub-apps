# iFinder & iAssistant Administrator's Integration Guide

**Complete setup and configuration guide for iFinder document search and iAssistant RAG integration**

This comprehensive guide provides step-by-step instructions for administrators to successfully configure and deploy iFinder document search and iAssistant RAG (Retrieval-Augmented Generation) capabilities within iHub Apps after initial installation.

## Table of Contents

1. [Overview](#overview)
2. [What Are iFinder and iAssistant?](#what-are-ifinder-and-iassistant)
3. [Prerequisites](#prerequisites)
4. [Post-Installation Setup](#post-installation-setup)
5. [iFinder Configuration](#ifinder-configuration)
6. [iAssistant Configuration](#iassistant-configuration)
7. [Tool Configuration](#tool-configuration)
8. [Application Setup](#application-setup)
9. [Complete Configuration Examples](#complete-configuration-examples)
10. [Testing and Validation](#testing-and-validation)
11. [Troubleshooting](#troubleshooting)
12. [Security Considerations](#security-considerations)
13. [Performance Optimization](#performance-optimization)
14. [Monitoring and Maintenance](#monitoring-and-maintenance)

## Overview

This guide assumes you have already completed the basic installation of iHub Apps using one of the supported installation methods (Binary, Docker, npm, or Electron). The focus here is on configuring the enterprise-grade document search and RAG capabilities that connect your iHub Apps instance to iFinder and iAssistant platforms.

### Integration Benefits

- **Enterprise Knowledge Access**: Direct access to corporate document repositories through natural language queries
- **RAG-Powered Responses**: Intelligent answers backed by your organization's specific documents and data
- **User Authentication**: Secure, user-context-aware document access respecting organizational permissions
- **Workspace (Conversation) API**: Conversational multi-turn chat with iAssistant via the Workspace API
- **Seamless UX**: Consistent interface experience across different interaction patterns

## What Are iFinder and iAssistant?

### iFinder: Enterprise Search Platform

**iFinder** is a comprehensive enterprise search and document management platform that provides:

- **Document Indexing**: Automatic indexing of documents from various sources (SharePoint, file systems, databases)
- **Advanced Search**: Full-text search with filters, facets, and metadata-based queries
- **User Permissions**: Respects organizational access controls and user permissions
- **API Access**: RESTful APIs for programmatic document search and content retrieval
- **Search Profiles**: Configurable search profiles for different content types and use cases

**Key Components:**
- Search API endpoints for document discovery
- Content retrieval APIs for full document text
- Metadata APIs for document information
- JWT-based user authentication

### iAssistant: RAG-Based AI Assistant

**iAssistant** is an AI-powered question-answering system built on top of iFinder that provides:

- **RAG Capabilities**: Retrieval-Augmented Generation combining search with AI response synthesis
- **Contextual Answers**: Responses based on actual enterprise documents and data
- **Source Attribution**: Clear citation of source documents used in responses
- **Streaming Responses**: Real-time response generation with Server-Sent Events (SSE)
- **Telemetry**: Detailed metrics about document retrieval and response generation

**Key Characteristics:**
- Conversational: Supports multi-turn chat via the Workspace (Conversation) API
- Document-grounded: All responses backed by retrieved documents
- User-aware: All queries execute in authenticated user context
- Streaming-capable: Real-time response delivery

### Integration Architecture

```mermaid
graph TB
    A[iHub Apps User] --> B[iHub Apps Frontend]
    B --> C[iHub Apps Server]
    C --> D{Integration Type}

    D --> E[iFinder Tools]
    D --> F[iAssistant Workspace]

    E --> H[iFinder API]
    F --> I[iAssistant Conversation API]

    H --> J[iFinder Search Engine]
    I --> J
    J --> K[Enterprise Documents]

    L[JWT Authentication] --> H
    L --> I

    M[User Context] --> L
    C --> M
```

## Prerequisites

### System Requirements

Before configuring iFinder and iAssistant integration, ensure you have:

**Infrastructure Access:**
- iFinder instance with API access enabled
- iAssistant RAG service configured and running
- Network connectivity from iHub Apps to both services
- Administrative access to both iFinder and iAssistant configurations

**Authentication Requirements:**
- RSA private key for JWT token signing (RS256 algorithm)
- Corresponding public key configured in iFinder/iAssistant
- User directory integration (iFinder must recognize user identities from iHub Apps)

**iHub Apps Prerequisites:**
- iHub Apps installed and running
- User authentication configured (local, OIDC, or proxy auth)
- Administrative access to iHub Apps configuration files

### Network Configuration

Ensure network connectivity:

```bash
# Test iFinder API connectivity
curl -I https://your-ifinder-instance.com/public-api/health

# Test iAssistant API connectivity  
curl -I https://your-iassistant-instance.com/health

# Verify ports are accessible (typically 443 for HTTPS)
telnet your-ifinder-instance.com 443
telnet your-iassistant-instance.com 443
```

## Post-Installation Setup

### 1. Verify iHub Apps Installation

Confirm your iHub Apps installation is functional:

```bash
# Check server status
curl http://localhost:3000/api/health

# Verify configuration directory exists
ls contents/config/

# Confirm default files are present
ls contents/config/platform.json
ls contents/config/tools.json
ls contents/models/
ls contents/apps/
```

### 2. Backup Configuration

Before making changes, backup existing configuration:

```bash
# Create backup directory
mkdir -p backups/$(date +%Y%m%d_%H%M%S)

# Backup current configuration
cp -r contents/ backups/$(date +%Y%m%d_%H%M%S)/
```

### 3. Prepare JWT Keys

Generate or obtain your RSA key pair for JWT signing:

```bash
# Generate new RSA key pair (if needed)
openssl genrsa -out ifinder_private_key.pem 2048
openssl rsa -in ifinder_private_key.pem -pubout -out ifinder_public_key.pem

# Display private key for configuration
cat ifinder_private_key.pem
```

**Important**: The public key must be configured in your iFinder/iAssistant instance to validate JWT tokens generated by iHub Apps.

## iFinder Configuration

### 1. Environment Variables Setup

Set the required environment variables for iFinder integration:

**Method 1: Environment Variables**
```bash
# Required iFinder settings
export IFINDER_API_URL="https://your-ifinder-instance.com"
export IFINDER_SEARCH_PROFILE="searchprofile-standard"
export IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...
-----END PRIVATE KEY-----"

# Optional iFinder settings
export IFINDER_TIMEOUT=30000
export IFINDER_DOWNLOAD_DIR="/tmp/ifinder-downloads"
```

**Method 2: Configuration File**
Add to your startup script or `.env` file:
```bash
# Save to .env or config.env
echo 'IFINDER_API_URL=https://your-ifinder-instance.com' >> .env
echo 'IFINDER_SEARCH_PROFILE=searchprofile-standard' >> .env
echo 'IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...
-----END PRIVATE KEY-----"' >> .env
```

### 2. Platform Configuration

Add iFinder configuration to `contents/config/platform.json`:

```json
{
  "iFinder": {
    "baseUrl": "https://your-ifinder-instance.com",
    "defaultSearchProfile": "searchprofile-standard",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...\n-----END PRIVATE KEY-----",
    "endpoints": {
      "search": "/public-api/retrieval/api/v1/search-profiles/{profileId}/_search",
      "document": "/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}"
    },
    "timeout": 30000,
    "downloadDir": "/tmp/ifinder-downloads",
    "algorithm": "RS256",
    "issuer": "ihub-apps",
    "audience": "ifinder-api",
    "defaultScope": "fa_index_read",
    "tokenExpirationSeconds": 3600
  }
}
```

**Configuration Parameters:**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `baseUrl` | iFinder instance URL | Yes | - |
| `defaultSearchProfile` | Default search profile ID | Yes | - |
| `privateKey` | RSA private key (PEM format) | Yes | - |
| `timeout` | Request timeout (ms) | No | 30000 |
| `algorithm` | JWT signing algorithm | No | RS256 |
| `issuer` | JWT issuer claim | No | ihub-apps |
| `audience` | JWT audience claim | No | ifinder-api |
| `defaultScope` | JWT scope claim | No | fa_index_read |
| `tokenExpirationSeconds` | JWT token TTL | No | 3600 |

### 3. Search Profile Configuration

Configure search profiles in iFinder for different content types:

**Example Search Profiles:**
- `searchprofile-standard`: General document search
- `searchprofile-policies`: Company policies and procedures
- `searchprofile-technical`: Technical documentation
- `searchprofile-hr`: HR documents and forms

Contact your iFinder administrator to set up appropriate search profiles with proper user permissions.

## iAssistant Configuration

### 1. Environment Variables Setup

Configure iAssistant-specific settings:

```bash
# iAssistant RAG service URL
export IASSISTANT_BASE_URL="https://your-iassistant-instance.com"

# Default iAssistant configuration
export IASSISTANT_PROFILE_ID="searchprofile-standard"
export IASSISTANT_SEARCH_MODE="multiword"
export IASSISTANT_TIMEOUT=45000
```

### 2. Platform Configuration

Add iAssistant configuration to `contents/config/platform.json`:

```json
{
  "iAssistant": {
    "baseUrl": "https://your-iassistant-instance.com",
    "endpoint": "/api/v2/rag",
    "defaultProfileId": "searchprofile-standard",
    "defaultSearchMode": "multiword",
    "defaultSearchDistance": "",
    "defaultFilter": [
      {
        "key": "application.keyword",
        "values": ["PDF", "DOCX", "TXT"],
        "isNegated": false
      }
    ],
    "defaultSearchFields": {},
    "timeout": 45000,
    "streaming": true
  }
}
```

**Configuration Parameters:**

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `baseUrl` | iAssistant instance URL | Yes | - |
| `endpoint` | RAG API endpoint path | No | /api/v2/rag |
| `defaultProfileId` | Default search profile | Yes | - |
| `defaultSearchMode` | Search mode (multiword, phrase, etc.) | No | multiword |
| `defaultFilter` | Default document filters | No | [] |
| `timeout` | Request timeout (ms) | No | 45000 |
| `streaming` | Enable streaming responses | No | true |

### 3. Profile ID Encoding

iAssistant requires base64-encoded profile IDs. The system handles this automatically, but you can verify encoding:

```bash
# Encode profile ID
echo -n "searchprofile-standard" | base64
# Output: c2VhcmNocHJvZmlsZS1zdGFuZGFyZA==
```

## Tool Configuration

### 1. Enable iFinder Tools

The iFinder tools should already be configured in `contents/config/tools.json`. Verify the configuration:

```json
{
  "id": "iFinder",
  "name": {
    "en": "iFinder Document Management",
    "de": "iFinder Dokumentenverwaltung"
  },
  "description": {
    "en": "Comprehensive document search, content retrieval, and management for the iFinder system",
    "de": "Umfassende Dokumentensuche, Inhaltsabruf und -verwaltung für das iFinder-System"
  },
  "script": "iFinder.js",
  "functions": {
    "search": {
      "description": {
        "en": "Search for documents in the iFinder system",
        "de": "Nach Dokumenten im iFinder-System suchen"
      },
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": {
              "en": "Search query to find documents",
              "de": "Suchanfrage zum Finden von Dokumenten"
            }
          },
          "maxResults": {
            "type": "integer",
            "default": 10,
            "minimum": 1,
            "maximum": 100
          }
        },
        "required": ["query"]
      }
    }
  }
}
```

### 2. Tool Method Reference

**iFinder Tool Methods:**

| Method | Purpose | Parameters | Response |
|--------|---------|------------|----------|
| `search` | Find documents | query, maxResults, searchProfile | Search results with metadata |
| `getContent` | Retrieve document text | documentId, maxLength | Full document content |
| `getMetadata` | Get document info | documentId | Document metadata only |

## Application Setup

### 1. Create Custom Enterprise Apps

**Example: Enterprise Knowledge Chat (using iFinder tools)**

Create `contents/apps/enterprise-knowledge-chat.json`:

```json
{
  "id": "enterprise-knowledge-chat",
  "order": 1,
  "name": {
    "en": "Enterprise Knowledge Chat",
    "de": "Unternehmenswissen Chat"
  },
  "description": {
    "en": "Chat with enterprise knowledge using iFinder document search",
    "de": "Chat mit Unternehmenswissen über iFinder-Dokumentensuche"
  },
  "color": "#2563eb",
  "icon": "building-columns",
  "system": {
    "en": "You are an enterprise knowledge assistant with access to company documents, policies, and procedures through iFinder. Provide accurate, helpful responses based on retrieved information. Always cite sources.",
    "de": "Sie sind ein Unternehmenswissensassistent mit Zugang zu Firmendokumenten, Richtlinien und Verfahren über iFinder. Geben Sie genaue, hilfreiche Antworten basierend auf abgerufenen Informationen. Zitieren Sie immer Quellen."
  },
  "tokenLimit": 32000,
  "preferredModel": "gpt-4o",
  "tools": [
    "iFinder.search",
    "iFinder.getContent"
  ],
  "messagePlaceholder": {
    "en": "Ask about company policies, procedures, or any enterprise information...",
    "de": "Fragen Sie nach Unternehmensrichtlinien, Verfahren oder anderen Unternehmensinformationen..."
  },
  "greeting": {
    "en": {
      "title": "Enterprise Knowledge Assistant",
      "subtitle": "Powered by iFinder",
      "text": "Hello! I can help you find information from company documents, policies, procedures, and more. What would you like to know?"
    },
    "de": {
      "title": "Unternehmenswissensassistent",
      "subtitle": "Powered by iFinder",
      "text": "Hallo! Ich kann Ihnen helfen, Informationen aus Firmendokumenten, Richtlinien, Verfahren und mehr zu finden. Was möchten Sie wissen?"
    }
  },
  "starterPrompts": [
    {
      "title": {"en": "Company Policies", "de": "Unternehmensrichtlinien"},
      "prompt": {"en": "What are the main company policies I should know about?", "de": "Was sind die wichtigsten Unternehmensrichtlinien, die ich kennen sollte?"}
    },
    {
      "title": {"en": "HR Procedures", "de": "HR-Verfahren"},
      "prompt": {"en": "How do I submit time off requests?", "de": "Wie reiche ich Urlaubsanträge ein?"}
    }
  ],
  "category": "Enterprise",
  "enabled": true
}
```

**Example: Multi-Modal Research Assistant**

Create `contents/apps/research-assistant.json`:

```json
{
  "id": "research-assistant",
  "order": 5,
  "name": {
    "en": "Research Assistant",
    "de": "Recherche-Assistent"
  },
  "description": {
    "en": "Comprehensive research using both web search and enterprise knowledge",
    "de": "Umfassende Recherche mit Websuche und Unternehmenswissen"
  },
  "color": "#7c3aed",
  "icon": "magnifying-glass-chart",
  "system": {
    "en": "You are a comprehensive research assistant with access to both web search and enterprise knowledge via iFinder. Always distinguish between internal and external sources.",
    "de": "Sie sind ein umfassender Recherche-Assistent mit Zugang zu Websuche und Unternehmenswissen über iFinder. Unterscheiden Sie immer zwischen internen und externen Quellen."
  },
  "tokenLimit": 32000,
  "preferredModel": "gpt-4o",
  "tools": [
    "iFinder.search",
    "iFinder.getContent",
    "braveSearch",
    "enhancedWebSearch"
  ],
  "sendChatHistory": true,
  "enabled": true
}
```

## Complete Configuration Examples

### 1. Basic Setup Example

**Environment Variables (.env):**
```bash
# iFinder Configuration
IFINDER_API_URL=https://ifinder.company.com
IFINDER_SEARCH_PROFILE=searchprofile-standard
IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...
-----END PRIVATE KEY-----"

# iAssistant Configuration  
IASSISTANT_BASE_URL=https://iassistant.company.com
```

**Platform Configuration (contents/config/platform.json):**
```json
{
  "serverName": "Company iHub Apps",
  "iFinder": {
    "baseUrl": "https://ifinder.company.com",
    "defaultSearchProfile": "searchprofile-standard",
    "privateKey": "${IFINDER_PRIVATE_KEY}",
    "timeout": 30000
  },
  "iAssistant": {
    "baseUrl": "https://iassistant.company.com", 
    "defaultProfileId": "searchprofile-standard",
    "streaming": true,
    "timeout": 45000
  }
}
```

### 2. Advanced Multi-Profile Setup

**Platform Configuration:**
```json
{
  "iFinder": {
    "baseUrl": "https://ifinder.company.com",
    "defaultSearchProfile": "searchprofile-standard",
    "privateKey": "${IFINDER_PRIVATE_KEY}",
    "profiles": {
      "hr": "searchprofile-hr-docs",
      "technical": "searchprofile-tech-docs", 
      "policies": "searchprofile-policies",
      "public": "searchprofile-public"
    },
    "timeout": 30000
  },
  "iAssistant": {
    "baseUrl": "https://iassistant.company.com",
    "defaultProfileId": "searchprofile-standard",
    "profileMappings": {
      "hr": "aHItZG9jcw==",
      "technical": "dGVjaC1kb2Nz", 
      "policies": "cG9saWNpZXM=",
      "public": "cHVibGlj"
    },
    "streaming": true
  }
}
```

**Application Using Specific Profiles:**
```json
{
  "id": "hr-assistant",
  "name": {"en": "HR Assistant"},
  "preferredModel": "gpt-4o",
  "tools": [
    "iFinder.search",
    "iFinder.getContent"
  ]
}
```

### 3. Production Security Configuration

**Platform Configuration with Enhanced Security:**
```json
{
  "iFinder": {
    "baseUrl": "https://ifinder.company.com",
    "defaultSearchProfile": "searchprofile-standard",
    "privateKey": "${IFINDER_PRIVATE_KEY}",
    "algorithm": "RS256",
    "issuer": "ihub-apps-production",
    "audience": "ifinder-api-production",
    "tokenExpirationSeconds": 1800,
    "defaultScope": "fa_index_read",
    "timeout": 25000,
    "retries": 3,
    "rateLimiting": {
      "enabled": true,
      "requestsPerMinute": 60,
      "burstLimit": 10
    }
  },
  "iAssistant": {
    "baseUrl": "https://iassistant.company.com",
    "defaultProfileId": "searchprofile-standard", 
    "streaming": true,
    "timeout": 40000,
    "maxConcurrentRequests": 5,
    "rateLimiting": {
      "enabled": true,
      "requestsPerMinute": 30
    }
  }
}
```

### 4. Development/Testing Configuration

**Development Platform Configuration:**
```json
{
  "iFinder": {
    "baseUrl": "https://ifinder-dev.company.com",
    "defaultSearchProfile": "searchprofile-test",
    "privateKey": "${IFINDER_DEV_PRIVATE_KEY}",
    "timeout": 60000,
    "debug": true,
    "mockResponses": false
  },
  "iAssistant": {
    "baseUrl": "https://iassistant-dev.company.com",
    "defaultProfileId": "searchprofile-test",
    "streaming": true,
    "debug": true,
    "timeout": 60000,
    "logRequests": true,
    "logResponses": true
  },
  "debug": {
    "logLevel": "debug",
    "enableRequestLogging": true,
    "enableResponseLogging": true
  }
}
```

## Testing and Validation

### 1. Connection Testing

**Test iFinder Connectivity:**
```bash
# Basic connectivity test
curl -I https://your-ifinder-instance.com/public-api/health

# Test with authentication (if health endpoint requires auth)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     https://your-ifinder-instance.com/public-api/health
```

**Test iAssistant Connectivity:**
```bash
# Basic connectivity test  
curl -I https://your-iassistant-instance.com/health

# Test RAG endpoint availability
curl -I https://your-iassistant-instance.com/api/v2/rag
```

### 2. JWT Token Validation

**Test JWT Token Generation:**
```bash
# Start iHub Apps in development mode with debug logging
DEBUG=true npm run dev

# Check server logs for JWT generation messages:
# "Generating iFinder JWT for user: user@company.com"
# "JWT token generated successfully"
```

**Verify JWT Token Format:**

Use a JWT decoder tool to verify token structure:
```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "user@company.com",
    "name": "User Name", 
    "admin": false,
    "iat": 1641234567,
    "exp": 1641238167,
    "scope": "fa_index_read",
    "iss": "ihub-apps",
    "aud": "ifinder-api"
  }
}
```

### 3. Functional Testing

**Test iFinder Tools:**
1. Start iHub Apps with iFinder configuration
2. Create a test app with iFinder tools enabled
3. Test each tool function:
   - Search for documents
   - Retrieve document content  
   - Get document metadata
   - Test download functionality

**Test iAssistant (Workspace) Integration:**
1. Configure iAssistant Workspace (Conversation API) in platform settings
2. Create a test app with `iassistant-conversation` provider model
3. Test conversational question answering:
   - Ask questions about known documents
   - Verify response quality and source attribution
   - Test multi-turn conversation continuity

**Test Authentication Flow:**
1. Test with anonymous user (should fail)
2. Test with authenticated user (should succeed) 
3. Test with users having different permissions
4. Verify user context is properly passed

### 4. Performance Testing

**Monitor Response Times:**
- Check iHub Apps server logs for request duration
- Monitor iFinder API response times
- Set up alerts for slow responses (>10 seconds)

### 5. End-to-End Testing

**Complete Workflow Test:**
1. User logs into iHub Apps
2. Selects enterprise knowledge app
3. Asks question about company documents
4. Receives AI-generated response with sources
5. Follows up with related questions
6. Uses iFinder tools to explore specific documents

**Validation Checklist:**
- [ ] iFinder API connectivity established
- [ ] iAssistant RAG API accessible
- [ ] JWT tokens generated and accepted
- [ ] User authentication working
- [ ] Document search returning results
- [ ] RAG responses generated successfully  
- [ ] Streaming responses working (if enabled)
- [ ] Error handling functioning properly
- [ ] Logging and monitoring operational

## Troubleshooting

### 1. Common Connection Issues

**Problem: "iFinder search requires authenticated user"**
```
Cause: User is anonymous or authentication failed
Solutions:
- Verify user is logged in to iHub Apps
- Check authentication mode in platform.json
- Ensure user session is valid
- Review authentication logs
```

**Problem: "iFinder authentication failed. Please check JWT configuration."**
```
Cause: JWT token generation or validation failed
Solutions:
- Verify private key format (must be PEM format)
- Check private key matches public key in iFinder
- Ensure JWT algorithm is RS256
- Validate JWT claims (issuer, audience, scope)
- Check token expiration time
```

**Problem: "iAssistant connection failed"**  
```
Cause: Network connectivity or service issues
Solutions:
- Verify iAssistant base URL is correct and accessible
- Check network connectivity: ping iassistant-host
- Verify iAssistant service is running
- Check firewall rules
- Review iAssistant service logs
```

### 2. Configuration Issues

**Problem: "No handler registered for type 'iassistant'"**
```
Cause: iAssistant adapter not properly registered
Solutions:
- Verify server/adapters/iassistant.js exists
- Check server/adapters/index.js includes iAssistant adapter
- Restart iHub Apps server
- Check server startup logs for adapter registration
```

**Problem: "Model 'iassistant' not found"**
```
Cause: iAssistant model not enabled or configured
Solutions:
- Check contents/models/iassistant.json exists
- Verify "enabled": true in model configuration
- Restart server after model changes
- Check model loading logs
```

**Problem: "Tool 'iAssistant_ask' not found"**
```
Cause: iAssistant tool not properly configured
Solutions:
- Verify contents/config/tools.json includes iAssistant tool
- Check server/tools/iAssistant.js exists
- Verify tool script exports ask function
- Restart server and check tool loading logs
```

### 3. Authentication Debugging

**Enable Debug Logging:**
```json
{
  "debug": {
    "logLevel": "debug",
    "enableJWTLogging": true,
    "enableAuthenticationLogging": true
  }
}
```

**JWT Token Debugging:**
```bash
# Check JWT token content without verification
node -e "
const jwt = require('jsonwebtoken');
const token = 'YOUR_JWT_TOKEN_HERE';
console.log(JSON.stringify(jwt.decode(token), null, 2));
"
```

**Authentication Flow Debugging:**
1. Check iHub Apps authentication logs
2. Verify user object contains required fields (id, email)
3. Check JWT token generation logs
4. Verify iFinder/iAssistant accepts the token
5. Check API response for authentication errors

### 4. Performance Issues

**Problem: Slow Response Times**
```
Possible Causes:
- Network latency to iFinder/iAssistant
- Large document corpus search
- Complex document filters
- Insufficient server resources

Solutions:
- Increase timeout values
- Optimize search profiles and filters
- Use streaming responses
- Implement request caching
- Monitor server resource usage
```

**Problem: High Memory Usage**  
```
Possible Causes:
- Large document content retrieval
- Streaming response buffering
- Memory leaks in long-running processes

Solutions:
- Limit maxLength for content retrieval
- Implement proper stream cleanup
- Monitor memory usage patterns
- Restart server periodically
```

### 5. Error Message Reference

| Error Message | Cause | Solution |
|---------------|--------|----------|
| "Request timeout" | Network or service delay | Increase timeout values |
| "Invalid search profile" | Profile doesn't exist | Verify profile ID in iFinder |
| "Insufficient permissions" | User lacks access | Check user permissions in iFinder |
| "Document not found" | Invalid document ID | Verify document exists and user has access |
| "Malformed JWT token" | Token generation issue | Check private key and JWT configuration |
| "Service unavailable" | iFinder/iAssistant down | Check service status and connectivity |
| "Rate limit exceeded" | Too many requests | Implement request throttling |

### 6. Log Analysis

**Important Log Patterns to Monitor:**

```bash
# Successful operations
grep "iFinder Search: User .* searching" server.log
grep "iAssistant: Generated response" server.log
grep "JWT token generated successfully" server.log

# Error patterns  
grep "ERROR.*iFinder\|iAssistant" server.log
grep "Authentication failed" server.log
grep "Connection timeout" server.log

# Performance monitoring
grep "Request duration:" server.log | grep -E "(iFinder|iAssistant)"
```

## Security Considerations

### 1. Authentication Security

**JWT Token Security:**
- Use strong RSA keys (2048-bit minimum)
- Rotate keys regularly (quarterly recommended)
- Store private keys securely (environment variables, key vaults)
- Set appropriate token expiration times (1-4 hours)
- Use different keys for different environments

**User Context Security:**
- All requests made in authenticated user context
- No privilege escalation through service accounts
- User permissions enforced at iFinder/iAssistant level
- Audit logging tracks all user activities

### 2. Network Security

**Transport Security:**
- Enforce HTTPS for all API communications
- Validate SSL/TLS certificates  
- Use proper certificate chain validation
- Consider certificate pinning for production

**Network Segmentation:**
- Place iFinder/iAssistant in secure network segments
- Use firewalls to restrict access
- Consider VPN or private networking
- Monitor network traffic for anomalies

### 3. Data Security

**Document Access Control:**
- User permissions enforced by iFinder
- No caching of sensitive document content
- Audit logging for document access
- Support for data classification labels

**Information Leakage Prevention:**
- Sanitize error messages
- Limit response size and content
- Monitor for sensitive data exposure
- Implement content filtering if needed

### 4. Configuration Security

**Sensitive Configuration:**
```bash
# Use environment variables for secrets
export IFINDER_PRIVATE_KEY="$(cat /secure/path/ifinder_key.pem)"
export IFINDER_API_URL="https://internal-ifinder.company.com"

# Avoid storing secrets in configuration files
```

**File Permissions:**
```bash
# Secure configuration files
chmod 600 .env
chmod 600 contents/config/platform.json
chown app:app contents/config/

# Secure private keys
chmod 600 /secure/path/ifinder_key.pem
chown root:app /secure/path/ifinder_key.pem
```

### 5. Operational Security

**Monitoring and Alerting:**
- Monitor authentication failure rates
- Alert on unusual access patterns  
- Track API error rates and response times
- Log security events for audit

**Incident Response:**
- Document incident response procedures
- Plan for key compromise scenarios
- Prepare service isolation procedures
- Maintain contact information for escalation

## Performance Optimization

### 1. Request Optimization

**Concurrent Request Limits:**
```json
{
  "iAssistant": {
    "maxConcurrentRequests": 5,
    "requestQueue": {
      "maxSize": 50,
      "timeoutMs": 30000
    }
  }
}
```

**Timeout Optimization:**
```json
{
  "iFinder": {
    "timeout": 25000,
    "retries": 2,
    "retryDelay": 1000
  },
  "iAssistant": {
    "timeout": 40000,
    "streamingTimeout": 60000
  }
}
```

### 2. Caching Strategies

**Response Caching (Use Carefully):**
```json
{
  "caching": {
    "enabled": false,
    "ttl": 0
  }
}
```

**Note:** Be cautious with caching user-specific enterprise data. Consider:
- User permission changes
- Document updates
- Data sensitivity
- Compliance requirements

**JWT Token Caching:**
```json
{
  "jwtCaching": {
    "enabled": true,
    "sessionDuration": 3600,
    "renewThreshold": 600
  }
}
```

### 3. Resource Management

**Memory Optimization:**
```json
{
  "iFinder": {
    "maxContentLength": 50000,
    "streamBufferSize": 8192
  },
  "iAssistant": {
    "maxResponseLength": 100000,
    "streamChunkSize": 1024
  }
}
```

**Connection Pooling:**
```json
{
  "httpOptions": {
    "keepAlive": true,
    "maxSockets": 10,
    "maxFreeSockets": 5,
    "timeout": 30000
  }
}
```

### 4. Search Optimization

**iFinder Search Optimization:**
- Use specific search profiles for different content types
- Optimize search filters to reduce result sets
- Limit field returns to necessary data
- Use appropriate maxResults limits

**iAssistant RAG Optimization:**
- Tune search relevance parameters
- Optimize document filters  
- Balance result quantity vs quality
- Use appropriate search modes for query types

### 5. Monitoring and Metrics

**Performance Metrics to Track:**

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| iAssistant Response Time | <5s | >10s |
| iFinder Search Time | <2s | >5s |  
| Document Retrieval Time | <3s | >7s |
| Authentication Success Rate | >99% | <95% |
| API Error Rate | <1% | >5% |

**Monitoring Configuration:**
```json
{
  "monitoring": {
    "enabled": true,
    "metrics": {
      "responseTimes": true,
      "errorRates": true,
      "userActivity": true,
      "systemHealth": true
    },
    "alerting": {
      "email": "admin@company.com",
      "webhook": "https://monitoring.company.com/alerts",
      "thresholds": {
        "responseTime": 10000,
        "errorRate": 0.05,
        "authFailureRate": 0.01
      }
    }
  }
}
```

## Monitoring and Maintenance

### 1. Health Checks

**Implement Health Check Endpoints:**
```bash
# Check iHub Apps health
curl http://localhost:3000/api/health

# Check iFinder integration health  
curl http://localhost:3000/api/admin/health/ifinder

# Check iAssistant integration health
curl http://localhost:3000/api/admin/health/iassistant
```

**Automated Health Monitoring:**
```json
{
  "healthChecks": {
    "enabled": true,
    "interval": 60000,
    "checks": {
      "ifinder": {
        "enabled": true,
        "timeout": 10000,
        "failureThreshold": 3
      },
      "iassistant": {
        "enabled": true, 
        "timeout": 15000,
        "failureThreshold": 3
      }
    },
    "notifications": {
      "email": "admin@company.com",
      "webhook": "https://monitoring.company.com/health"
    }
  }
}
```

### 2. Log Management

**Log Configuration:**
```json
{
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["console", "file"],
    "file": {
      "path": "logs/ihub-apps.log",
      "maxSize": "100MB",
      "maxFiles": 10,
      "compress": true
    },
    "categories": {
      "ifinder": "info",
      "iassistant": "info", 
      "authentication": "info",
      "performance": "debug"
    }
  }
}
```

**Log Rotation Script:**
```bash
#!/bin/bash
# rotate-logs.sh
LOG_DIR="/path/to/logs"
BACKUP_DIR="/path/to/log-backups"
DAYS_TO_KEEP=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Compress and move old logs
find "$LOG_DIR" -name "*.log" -mtime +1 -exec gzip {} \;
find "$LOG_DIR" -name "*.log.gz" -mtime +0 -exec mv {} "$BACKUP_DIR" \;

# Clean old backups
find "$BACKUP_DIR" -name "*.log.gz" -mtime +$DAYS_TO_KEEP -delete
```

### 3. Maintenance Tasks

**Regular Maintenance Schedule:**

**Daily:**
- Check health check status
- Review error logs for new issues
- Monitor response times and error rates

**Weekly:**
- Review authentication patterns and failures
- Check disk space and log sizes
- Validate configuration file integrity
- Test backup and restore procedures

**Monthly:**
- Review and rotate JWT keys (if policy requires)
- Update documentation with configuration changes
- Performance review and optimization
- Security audit of access patterns

**Quarterly:**
- Full system backup and recovery test
- Security review and key rotation
- Configuration audit and cleanup
- Performance benchmarking

### 4. Backup and Recovery

**Configuration Backup:**
```bash
#!/bin/bash
# backup-config.sh
BACKUP_DIR="/backups/ihub-apps/$(date +%Y%m%d_%H%M%S)"
CONTENTS_DIR="/path/to/contents"

mkdir -p "$BACKUP_DIR"

# Backup configuration
cp -r "$CONTENTS_DIR" "$BACKUP_DIR/"

# Backup environment variables (without secrets)
env | grep -E "^(IFINDER|IASSISTANT)_" | grep -v "_KEY" > "$BACKUP_DIR/environment.txt"

# Create manifest
echo "Backup created: $(date)" > "$BACKUP_DIR/manifest.txt"
echo "iHub Apps version: $(node -e 'console.log(require("./package.json").version)')" >> "$BACKUP_DIR/manifest.txt"

# Compress backup
tar -czf "$BACKUP_DIR.tar.gz" -C "$BACKUP_DIR" .
rm -rf "$BACKUP_DIR"
```

**Recovery Procedures:**
1. Stop iHub Apps service
2. Restore configuration files from backup
3. Verify environment variables
4. Test configuration validity
5. Start service and verify functionality
6. Run full integration tests

### 5. Update Procedures

**Configuration Updates:**
1. Backup current configuration
2. Make changes to configuration files
3. Validate configuration syntax
4. Test changes in development environment
5. Deploy to production with rollback plan
6. Monitor for issues after deployment

**Service Updates:**
1. Plan maintenance window
2. Backup configuration and data
3. Update iHub Apps to new version
4. Update configuration for compatibility
5. Test iFinder/iAssistant integration
6. Monitor post-update performance

---

## Conclusion

This comprehensive administrator's guide provides complete instructions for setting up and maintaining iFinder and iAssistant integration with iHub Apps. The configuration enables powerful enterprise knowledge access through both direct RAG-powered chat and tool-based integration with other AI models.

### Key Success Factors

1. **Proper Authentication**: Ensure JWT configuration is correct and private keys are secure
2. **Network Connectivity**: Verify reliable connectivity to iFinder and iAssistant services  
3. **User Permissions**: Confirm user access rights in iFinder match expected behavior
4. **Monitoring**: Implement comprehensive monitoring and alerting
5. **Documentation**: Keep configuration documentation current and accessible

### Next Steps

After completing this setup:
1. Train users on the new enterprise knowledge capabilities
2. Gather feedback and optimize configurations
3. Expand to additional search profiles and use cases
4. Consider advanced features like custom filtering and specialized applications
5. Plan for scaling and performance optimization

For ongoing support, refer to the troubleshooting section, monitor system logs, and maintain regular communication with your iFinder and iAssistant system administrators.