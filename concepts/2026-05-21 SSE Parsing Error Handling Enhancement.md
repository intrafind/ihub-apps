# SSE Parsing Error Handling Enhancement

**Date:** 2026-05-21
**Issue:** #1137 - Network Error after multiple Searches via SSL
**Status:** Implemented

## Problem Statement

When using vLLM with gpt-oss model over SSL, users encountered network errors after 3-7 messages. The error manifested as:
- Red exclamation mark in the chat UI
- No error message displayed to the user
- No error messages in the system log
- Chat becomes unusable (only deleting chat helps to start again)

### Root Cause

According to the investigation, the issue is that **vLLM with gpt-oss leaks wrong tokens / sends SSEs which do not work**. The specific error mentioned was:

```
Unexpected tokens remaining in message header: Some("...We need to respond. The user says \"test\". Probably just respond confirming test.")
```

This error occurs when the SSE (Server-Sent Events) parser (`eventsource-parser` library) encounters malformed data that doesn't conform to the SSE specification. The parser throws an exception, but this exception was not being caught, leading to silent failures and unhelpful error messages for users.

## Solution

Since the underlying issue is with the vLLM model configuration and cannot be fixed in the iHub Apps codebase, the solution focuses on **better error handling and user feedback**.

### Implementation

#### 1. Translation Files

Added new error message keys to `shared/i18n/en.json` and `shared/i18n/de.json`:

```json
{
  "error": {
    "malformedSseData": "The model sent invalid data that could not be processed. This may be due to a model configuration issue. Please try again or contact your administrator if the problem persists.",
    "sseParsingError": "Error processing server response: {{error}}. The model may have sent malformed data. Please try a different model or contact support."
  }
}
```

#### 2. Server-Side Error Handling (`server/adapters/BaseAdapter.js`)

Enhanced the `parseSseStream` method to:

1. **Catch parsing errors** from `eventsource-parser.feed()`:
   ```javascript
   try {
     const chunk = decoder.decode(value, { stream: true });
     parser.feed(chunk);
   } catch (parseErr) {
     // Log detailed error information
     logger.error('SSE parsing error', {
       component: 'BaseAdapter',
       provider,
       error: parseErr.message,
       errorDetails: parseErr.toString()
     });

     // Yield error result to inform the user
     yield {
       content: [],
       complete: false,
       finishReason: 'error',
       error: true,
       errorMessage: `The model sent malformed data: ${parseErr.message}...`
     };
     return;
   }
   ```

2. **Catch conversion errors** from `convertResponseToGeneric()`:
   ```javascript
   try {
     const result = await convertResponseToGeneric(evt.data, provider);
     // ... process result
   } catch (conversionErr) {
     logger.error('Error converting SSE event to generic format', {
       component: 'BaseAdapter',
       provider,
       error: conversionErr.message
     });
     yield {
       content: [],
       complete: false,
       finishReason: 'error',
       error: true,
       errorMessage: `Error processing response: ${conversionErr.message}`
     };
   }
   ```

3. **Handle final parsing errors** when stream ends without processing events

#### 3. Client-Side Error Handling (`client/src/shared/utils/parseSseStream.js`)

Enhanced the client-side SSE parser to:

1. **Handle stream reading errors**:
   ```javascript
   try {
     ({ done, value } = await reader.read());
   } catch (err) {
     if (err.name === 'AbortError') break;
     console.error('Error reading SSE stream:', err);
     onEvent('error', {
       message: `Stream reading error: ${err.message}...`
     });
     throw err;
   }
   ```

2. **Handle line processing errors**:
   ```javascript
   try {
     processLine(line);
   } catch (err) {
     console.error('Error processing SSE line:', err, 'Line:', line);
     // Don't send error event for individual line failures - just log
   }
   ```

3. **Handle major parsing errors**:
   ```javascript
   catch (err) {
     console.error('Fatal SSE parsing error:', err);
     onEvent('error', {
       message: `Error parsing server events: ${err.message}...`
     });
   }
   ```

## Error Flow

When vLLM sends malformed SSE data:

1. **Server catches error** in `BaseAdapter.parseSseStream()`
2. **Logs detailed error** for troubleshooting (component, provider, error details)
3. **Yields error result** with user-friendly message
4. **StreamingHandler** receives the error result and passes it to the client via SSE
5. **Client displays** informative error message in the chat UI instead of silent failure
6. **User sees** a clear message explaining the issue and suggesting next steps

## Benefits

1. **User Visibility**: Users now see clear, actionable error messages instead of silent failures
2. **Troubleshooting**: Detailed logging helps administrators diagnose issues
3. **Error Recovery**: Users know to try a different model or contact support
4. **Graceful Degradation**: Errors don't crash the entire chat session
5. **Localized Messages**: Error messages available in English and German

## Files Modified

- `shared/i18n/en.json` - Added error message keys
- `shared/i18n/de.json` - Added German translations
- `server/adapters/BaseAdapter.js` - Enhanced SSE parsing error handling
- `client/src/shared/utils/parseSseStream.js` - Enhanced client-side error handling

## Recommendation

While this fix improves error handling and user feedback, the **root cause** is the vLLM model configuration. For production deployments:

1. **Update vLLM**: Try updating to the latest version
2. **Model Configuration**: Review gpt-oss model settings
3. **Alternative Models**: Consider using different models that don't have this issue
4. **Monitor Logs**: Watch for SSE parsing errors in production logs

## Related Issues

- Issue #1137: Network Error after multiple Searches via SSL
- vLLM SSE compatibility with eventsource-parser

## Testing

- ✅ Server starts without errors
- ✅ Linting passes (0 errors)
- ✅ Error messages available in English and German
- ✅ Parsing errors properly caught and logged
- ✅ No breaking changes to existing functionality
