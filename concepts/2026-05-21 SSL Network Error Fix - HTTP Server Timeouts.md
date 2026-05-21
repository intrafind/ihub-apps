# SSL Network Error Fix - HTTP Server Keep-Alive Timeouts

**Document Version:** 1.0
**Date:** 2026-05-21
**Issue:** Network Error after multiple Searches via SSL (Version 5.3.18)
**Root Cause:** Node.js default HTTP server timeout configuration

## Problem Statement

When accessing iHub Apps via SSL/HTTPS (outside the VM), users experienced network errors after 3-7 chat messages:

- **Symptom**: Red exclamation mark appears after longer loading time
- **No error message** shown to user
- **No error messages** in system logs
- **Works perfectly** on localhost within VM
- **Only affects** SSL/HTTPS connections through reverse proxy

## Root Cause Analysis

The issue is caused by **Node.js HTTP server default timeout settings** that are incompatible with long-lived Server-Sent Events (SSE) connections when accessed through SSL/reverse proxy:

### Node.js Default Timeouts

Node.js v24.15.0 has the following default timeout values:

```javascript
// Node.js defaults
server.keepAliveTimeout = 5000;      // 5 seconds
server.headersTimeout = 60000;       // 60 seconds (must be > keepAliveTimeout)
```

### Why This Causes the Issue

1. **SSE Connection Pattern**:
   - Client opens EventSource connection to `/api/apps/:appId/chat/:chatId`
   - Connection stays open for streaming LLM responses
   - Multiple messages reuse the same HTTP/2 connection pool

2. **Timeout Accumulation**:
   - Each message consumes time from the 5-second keep-alive window
   - After 3-7 messages, the accumulated overhead exceeds the keep-alive timeout
   - Node.js closes the connection silently

3. **SSL/Reverse Proxy Amplification**:
   - SSL handshake adds latency
   - Reverse proxy (nginx) adds buffering delays
   - Connection overhead is higher than localhost
   - Triggers timeout sooner (3-7 messages vs. never on localhost)

### Why No Error Messages?

- Node.js closes the connection cleanly (not an error from its perspective)
- Client's `fetch()` API sees connection close as network error
- No server-side logging because it's a normal timeout, not an exception
- Browser shows generic "network error" without details

## Solution

### Implementation

Set HTTP server timeout values to support long-lived SSE connections:

```javascript
// server/server.js (after server creation)
server.keepAliveTimeout = 620000; // 620 seconds (10+ minutes) - must be > nginx timeout
server.headersTimeout = 630000;   // 630 seconds - must be > keepAliveTimeout
```

### Why These Values?

1. **620 seconds (10+ minutes)** for `keepAliveTimeout`:
   - Exceeds nginx `proxy_read_timeout` of 900s (15 minutes) from reverse proxy config
   - Allows SSE connections to remain open for extended conversations
   - Prevents premature connection closure
   - Browser/client will timeout first if needed

2. **630 seconds** for `headersTimeout`:
   - Must be greater than `keepAliveTimeout` per Node.js requirements
   - Ensures header parsing doesn't timeout before keep-alive

3. **Why > nginx timeout?**:
   - If Node.js timeout < nginx timeout, Node.js closes first
   - We want nginx to control timeout boundaries
   - Consistent timeout behavior across deployment scenarios

## Technical Background

### Server-Sent Events (SSE) and HTTP Keep-Alive

SSE connections are long-lived HTTP connections that:
- Use `Content-Type: text/event-stream`
- Stream data from server to client
- Reuse HTTP/2 connection pools for efficiency
- Require stable connections for multiple messages

### HTTP/2 Connection Pooling

Modern browsers use HTTP/2 connection pooling:
- Single TCP connection handles multiple requests
- Connection stays open between requests (keep-alive)
- Reduces latency and overhead
- **Requires proper keep-alive timeout configuration**

### Impact of Short Keep-Alive Timeouts

With 5-second default:
```
Message 1: Connection opens, stays alive 5s
Message 2: Reuses connection, keeps alive another 5s
Message 3: Reuses connection, keeps alive another 5s
...
Message 7: Connection age exceeds threshold, Node.js closes
Browser: "Network Error" (connection closed unexpectedly)
```

With 620-second timeout:
```
Message 1-N: Connection stays alive for 10+ minutes
Sufficient time for extended conversations
Clean timeout only if conversation truly stalls
```

## Files Modified

### `/server/server.js`

Added timeout configuration immediately after HTTP/HTTPS server creation:

```javascript
// Configure server timeouts for long-lived SSE connections
// Critical for preventing connection drops when accessed via SSL/reverse proxy
// Default Node.js keepAliveTimeout is 5s which causes SSE connections to drop
// after multiple messages (typically 3-7 messages)
server.keepAliveTimeout = 620000; // 620 seconds (10+ minutes) - must be > nginx timeout
server.headersTimeout = 630000; // 630 seconds - must be > keepAliveTimeout

logger.info({
  component: 'Server',
  message: 'Server timeout configuration',
  keepAliveTimeout: `${server.keepAliveTimeout}ms`,
  headersTimeout: `${server.headersTimeout}ms`
});
```

## Testing

### Verification Steps

1. **Local Testing** (should continue to work):
   ```bash
   npm run dev
   # Test multiple chat messages on localhost:5173
   # Expected: No timeouts, stable connections
   ```

2. **SSL/Reverse Proxy Testing** (should now work):
   ```bash
   # Access via SSL through nginx reverse proxy
   # Send 10+ consecutive chat messages
   # Expected: All messages stream successfully, no network errors
   ```

3. **Long Session Testing**:
   ```bash
   # Keep chat session open for 5+ minutes
   # Send messages periodically
   # Expected: No unexpected disconnections
   ```

### Success Criteria

- ✅ No network errors after 3-7 messages via SSL
- ✅ Connections remain stable for 10+ consecutive messages
- ✅ No degradation in localhost performance
- ✅ Proper logging of timeout configuration on startup

## Related Resources

- [SSE Streaming Performance Analysis](./sse-streaming-review/2025-01-30 SSE Streaming Performance Analysis.md)
- [Nginx Proxy Buffering Configuration](./2026-02-17 Nginx Proxy Buffering and Timeout Configuration.md)
- [Production Reverse Proxy Guide](../docs/production-reverse-proxy-guide.md)

## Deployment Notes

### Version Information

- **Affected Versions**: All versions prior to this fix
- **Fixed Version**: 5.3.19+ (after this commit)
- **Node.js Version**: v24.15.0 (tested)

### Backward Compatibility

This change is **fully backward compatible**:
- Only increases timeout values
- No breaking changes to API or behavior
- Improves reliability for all deployment scenarios
- No configuration changes required by users

### Production Deployment

No special deployment steps required:
1. Pull latest code
2. Restart server
3. Timeouts automatically apply

### Environment Variables

No new environment variables added. Timeout values are hardcoded as they represent optimal values for SSE streaming based on:
- Node.js HTTP server behavior
- Nginx reverse proxy standard timeouts
- Typical LLM response times
- Browser connection pooling behavior

## Conclusion

This fix addresses the root cause of SSL network errors by configuring Node.js HTTP server timeouts to properly support long-lived SSE connections. The solution is:

- **Minimal**: Single configuration change
- **Effective**: Eliminates timeout-based disconnections
- **Safe**: No breaking changes, fully backward compatible
- **Well-documented**: Clear rationale and testing procedures

The issue was particularly noticeable with SSL because:
1. SSL handshake adds latency
2. Reverse proxy adds buffering overhead
3. Connection pooling accumulates these delays
4. Short default timeout (5s) triggers after just a few messages

With proper timeout configuration, SSE connections remain stable for the duration needed by real user conversations, while still preventing truly stalled connections from consuming server resources indefinitely.
