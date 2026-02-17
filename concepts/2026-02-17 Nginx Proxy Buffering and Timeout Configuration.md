# Nginx Proxy Buffering and Timeout Configuration for Server-Sent Events

**Document Version:** 1.0  
**Date:** 2026-02-17  
**Author:** GitHub Copilot  
**Purpose:** Document the critical nginx configuration changes required for proper Server-Sent Events (SSE) streaming in iHub Apps

## Overview

This document explains the importance of disabling proxy buffering and setting long timeouts in nginx configurations for iHub Apps. These settings are critical for proper Server-Sent Events (SSE) streaming functionality, which is used for real-time LLM chat responses.

## Problem Statement

Without proper nginx configuration, Server-Sent Events (SSE) used for streaming LLM chat responses will be buffered by nginx instead of being sent directly to clients. This causes:

1. **Poor User Experience**: Chat responses appear all at once instead of streaming word-by-word
2. **Connection Timeouts**: Long-running chat sessions are interrupted by nginx closing connections
3. **Degraded Performance**: Users see a frozen UI until the entire response is generated

## Solution

### Required Configuration Changes

Two critical nginx directives must be added to all proxy locations that handle streaming responses:

#### 1. Disable Proxy Buffering

```nginx
# CRITICAL: Disable buffering for Server-Sent Events (SSE)
proxy_buffering off;
proxy_request_buffering off;
```

**Why this is critical:**
- **`proxy_buffering off`**: Without this, nginx buffers the entire backend response before sending it to the client. This defeats the purpose of streaming and causes the UI to freeze until the entire LLM response is complete.
- **`proxy_request_buffering off`**: Prevents buffering of request bodies, useful for large file uploads and prevents delays in request processing.

#### 2. Set Long Timeouts

```nginx
# Timeouts for long-running streaming requests (24 hours)
proxy_connect_timeout 60s;
proxy_send_timeout 86400s;
proxy_read_timeout 86400s;
```

**Why these timeouts are necessary:**
- **`proxy_connect_timeout 60s`**: Time allowed for establishing connection to backend (kept at 60s as this should be fast)
- **`proxy_send_timeout 86400s`**: 24-hour timeout for sending data to the backend, preventing premature connection closure
- **`proxy_read_timeout 86400s`**: 24-hour timeout for reading responses from backend, allowing for extended chat sessions without interruption

**Note:** 86400 seconds = 24 hours, which accommodates even the longest chat sessions.

## Files Modified

The following files were updated to include these critical configurations:

### 1. Main Nginx Configuration Files

#### `/nginx.conf`
- Updated main proxy location block `/ihub/` with buffering disabled and 24-hour timeouts
- Added detailed comments explaining the purpose of each setting

#### `/docker/nginx.conf`
- Updated HTTP server proxy location `/ihub/` with streaming configurations
- Updated commented HTTPS server section with same settings for future use

### 2. Documentation Files

#### `/docs/production-reverse-proxy-guide.md`
- Updated production nginx configuration examples
- Updated development server configuration examples
- Updated SSE-specific location block examples
- Added enhanced comments explaining the importance of these settings

### 3. Concept Documents

#### `/concepts/reverse-proxy-nginx/nginx-proxy-howto.md`
- Added new section "Important Configuration Notes" explaining SSE streaming
- Added detailed explanation of why proxy_buffering off is critical
- Added explanation of timeout values and their purpose

#### `/concepts/docker-support/2025-07-28 Docker Implementation Examples.md`
- Updated API proxy location with buffering disabled and 24-hour timeouts
- Updated upload endpoint with buffering disabled
- Added explanatory comments

#### `/concepts/subpath-deployment/2025-08-07 Deployment Examples and Migration Guide.md`
- Updated nginx configuration example with streaming support
- Updated performance optimization section with corrected buffering settings
- Added explanatory comments about SSE streaming

## Configuration Template

Here's a complete nginx location block template for iHub Apps with proper SSE support:

```nginx
location /ihub/ {
    # Proxy to backend (strips /ihub prefix)
    proxy_pass http://localhost:3000/;
    
    # HTTP version and headers
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /ihub;
    proxy_cache_bypass $http_upgrade;
    
    # CRITICAL: Disable buffering for Server-Sent Events (SSE)
    # This ensures streaming responses are sent directly to clients
    proxy_buffering off;
    proxy_request_buffering off;
    
    # Timeouts for long-running LLM streaming requests (24 hours)
    # Prevents connection closure during extended chat sessions
    proxy_connect_timeout 60s;
    proxy_send_timeout 86400s;
    proxy_read_timeout 86400s;
    
    # Disable redirect following
    proxy_redirect off;
}
```

## Technical Background

### Server-Sent Events (SSE)

Server-Sent Events is a standard for streaming data from server to client over HTTP. In iHub Apps, SSE is used for:

- Real-time LLM chat response streaming
- Progressive display of AI-generated content
- Live updates during long-running operations

### How Nginx Buffering Affects SSE

When `proxy_buffering` is enabled (the default):

1. Nginx receives SSE chunks from the backend
2. Nginx **buffers** these chunks in memory
3. Nginx only sends data to the client when:
   - The buffer is full, OR
   - The backend closes the connection

This means SSE events are delayed or delivered all at once, breaking the streaming experience.

When `proxy_buffering off` is set:

1. Nginx receives SSE chunks from the backend
2. Nginx **immediately forwards** each chunk to the client
3. Client receives real-time updates as they are generated

### Why 24-Hour Timeouts?

The default nginx timeout values are typically 60 seconds, which is far too short for:

- **Extended conversations**: Users may have long back-and-forth discussions with AI
- **Complex queries**: Some LLM responses can take several minutes to generate
- **Slow network conditions**: Network delays should not cause premature disconnection

A 24-hour timeout (`86400s`) ensures that even the longest sessions remain connected without interruption.

## Impact on User Experience

### Before These Changes
- ❌ Chat responses appear all at once after generation completes
- ❌ No visual feedback during LLM processing
- ❌ Connections timeout on long conversations
- ❌ Poor perceived performance

### After These Changes
- ✅ Chat responses stream word-by-word as generated
- ✅ Immediate visual feedback during LLM processing
- ✅ Extended conversations remain connected
- ✅ Excellent perceived performance

## Deployment Checklist

When deploying iHub Apps behind nginx, ensure:

- [ ] `proxy_buffering off` is set in all proxy locations
- [ ] `proxy_request_buffering off` is set in all proxy locations
- [ ] `proxy_read_timeout` is set to 86400s (24 hours) for streaming endpoints
- [ ] `proxy_send_timeout` is set to 86400s (24 hours) for streaming endpoints
- [ ] `proxy_connect_timeout` is set to at least 60s
- [ ] Configuration is tested with actual LLM streaming responses
- [ ] Long-running chat sessions are tested (verify no timeouts)

## Testing

To verify proper configuration:

1. **Test Streaming Behavior**:
   ```bash
   # Start a chat session and observe that responses stream word-by-word
   # Not all at once
   ```

2. **Test Long Sessions**:
   ```bash
   # Keep a chat session open for several hours
   # Verify no timeout errors occur
   ```

3. **Check Nginx Configuration**:
   ```bash
   # Verify configuration syntax
   nginx -t
   
   # Check for proxy_buffering settings
   grep -r "proxy_buffering" /etc/nginx/
   ```

## Related Resources

- [Production Reverse Proxy Guide](../docs/production-reverse-proxy-guide.md) - Complete nginx setup guide
- [Nginx Proxy How-To](./reverse-proxy-nginx/nginx-proxy-howto.md) - Development nginx setup
- [Docker Implementation Examples](./docker-support/2025-07-28 Docker Implementation Examples.md) - Docker with nginx
- [Subpath Deployment Guide](./subpath-deployment/2025-08-07 Deployment Examples and Migration Guide.md) - Subpath-specific nginx configuration

## Conclusion

Disabling proxy buffering and setting long timeouts in nginx is **critical** for proper Server-Sent Events functionality in iHub Apps. These settings must be included in all nginx configurations that proxy to the iHub Apps backend to ensure optimal user experience and prevent connection issues during streaming operations.

All nginx configurations throughout the repository and documentation have been updated to include these settings with detailed explanatory comments.
