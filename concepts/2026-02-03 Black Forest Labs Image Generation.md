# Black Forest Labs (BFL) Image Generation Integration

**Date:** 2026-02-03  
**Author:** Copilot  
**Status:** Implementation in Progress

## Overview

This document outlines the integration of Black Forest Labs (BFL) FLUX models for image generation into the iHub Apps platform. BFL provides state-of-the-art image generation models through an asynchronous API.

## Research Summary

### BFL API Architecture

Black Forest Labs uses an **asynchronous polling architecture** for image generation:

1. **Submit Request** → Receive `request_id` and `polling_url`
2. **Poll for Results** → Check status until `Ready`, `Error`, or moderated
3. **Download Image** → Retrieve from signed URL (expires in 10 minutes)

### Authentication

- **Header:** `x-key: YOUR_API_KEY`
- **Additional Headers:** 
  - `accept: application/json`
  - `Content-Type: application/json`

### Available Models

#### FLUX.2 Family (Latest Generation)

| Model | Endpoint | Best For | Speed | Multi-Reference | Grounding Search |
|-------|----------|----------|-------|-----------------|------------------|
| **FLUX.2 [klein-4b]** | `/flux-2-klein-4b` | High volume, real-time | Sub-second | Up to 4 | No |
| **FLUX.2 [klein-9b]** | `/flux-2-klein-9b` | Balanced quality/speed | Sub-second | Up to 4 | No |
| **FLUX.2 [max]** | `/flux-2-max` | Highest quality, final assets | ~6 seconds | Up to 8-10 | **Yes** |
| **FLUX.2 [pro]** | `/flux-2-pro` | Production at scale | ~5 seconds | Up to 8-10 | No |
| **FLUX.2 [flex]** | `/flux-2-flex` | Typography & fine control | ~6 seconds | Up to 8-10 | No |

#### FLUX.1 Kontext Family (Image Editing)

| Model | Endpoint | Best For | Features |
|-------|----------|----------|----------|
| **FLUX.1 Kontext [max]** | `/flux-kontext-max` | Industry-leading quality | Text-to-image, image editing, character consistency |
| **FLUX.1 Kontext [pro]** | `/flux-kontext-pro` | Fast production | Unified editing & generation mode |

#### FLUX.1 Legacy Models

| Model | Endpoint | Use Case |
|-------|----------|----------|
| **FLUX Pro 1.1 Ultra** | `/flux-pro-1.1-ultra` | Ultra-high resolution |
| **FLUX Pro 1.1** | `/flux-pro-1.1` | High quality production |
| **FLUX Pro** | `/flux-pro` | Standard production |
| **FLUX Dev** | `/flux-dev` | Development/testing |

### Key Features

#### 1. **Grounding Search** (FLUX.2 [max] only)
- Real-time web search integration
- Creates images based on current events, weather, locations
- Example: "Generate an image of yesterday's football game"

#### 2. **Multi-Reference Images**
- Combine elements from multiple reference images
- Maintain character/object identity across scenes
- Use up to 4-10 images depending on model

#### 3. **Hex Color Control**
- Precise color specification: `#RRGGBB`
- Example: "A vase with gradient from #02eb3c to #edfa3c"

#### 4. **Typography Support**
- Reliable text rendering in images
- Perfect for infographics, UI mockups, marketing

#### 5. **Structured Prompting**
- JSON-based prompt structure for precise control
- Recommended for production workflows

### API Response Statuses

- `Ready` - Generation complete, image available
- `Pending` - Request still processing
- `Request Moderated` - Input flagged before processing
- `Content Moderated` - Output flagged after processing
- `Task not found` - Invalid or expired task ID
- `Error` - Processing error

### Content Moderation

The `safety_tolerance` parameter controls moderation sensitivity:
- `0` - Most strict (default: `2`)
- `6` - Least strict

### Error Codes

- `400` - Bad Request (malformed parameters)
- `402` - Payment Required (insufficient credits)
- `403` - Forbidden (invalid API key)
- `422` - Unprocessable Entity (invalid parameters)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error
- `503` - Service Unavailable (maintenance/high load)

### Rate Limits

- Standard models: 24 concurrent requests
- Kontext Max: 6 concurrent requests

### Regional Endpoints

- **Global:** `api.bfl.ai` (automatic failover)
- **EU:** `api.eu.bfl.ai` (GDPR compliant)
- **US:** `api.us.bfl.ai` (US data residency)

### Image URL Expiration

- Generated images available via signed URLs
- **URLs expire after 10 minutes**
- Must download immediately upon completion
- Recommended: Re-serve from own CDN/storage

## Implementation Plan

### 1. BFL Adapter

Create `server/adapters/bfl.js` with:

- **Async Request Handling:** Submit generation requests
- **Polling Mechanism:** Poll for results with exponential backoff
- **Image Processing:** Handle base64 conversion from signed URLs
- **Error Handling:** Map BFL errors to standard format
- **Moderation Handling:** Handle content moderation responses

### 2. Adapter Methods

```javascript
class BFLAdapter extends BaseAdapter {
  // Submit image generation request
  async createCompletionRequest(model, messages, apiKey, options)
  
  // Poll for results with exponential backoff
  async pollForResults(pollingUrl, apiKey, maxRetries, initialDelay)
  
  // Download and convert image to base64
  async downloadImage(imageUrl)
  
  // Process response buffer (adapt to sync architecture)
  processResponseBuffer(data)
  
  // Format messages for BFL API
  formatMessages(messages)
}
```

### 3. Key Differences from Existing Adapters

| Aspect | Existing (OpenAI, Google) | BFL |
|--------|--------------------------|-----|
| **API Type** | Synchronous streaming | Asynchronous polling |
| **Response** | Server-Sent Events (SSE) | Polling with status checks |
| **Image Format** | Inline base64 in stream | Signed URL → download → convert |
| **Timing** | Real-time chunks | Submit → wait → retrieve |

### 4. Adapter Registry Update

Add to `server/adapters/index.js`:

```javascript
import BFLAdapter from './bfl.js';

const adapters = {
  // ... existing adapters
  bfl: BFLAdapter
};
```

### 5. Model Configuration Examples

#### FLUX.2 [pro] Example

```json
{
  "id": "flux-2-pro",
  "modelId": "flux-2-pro",
  "name": {
    "en": "FLUX.2 Pro",
    "de": "FLUX.2 Pro"
  },
  "description": {
    "en": "Production-ready image generation at scale. Fast and high quality.",
    "de": "Produktionsbereite Bildgenerierung im großen Maßstab. Schnell und hochwertig."
  },
  "url": "https://api.bfl.ai/v1/flux-2-pro",
  "provider": "bfl",
  "tokenLimit": 0,
  "supportsImageGeneration": true,
  "imageGeneration": {
    "width": 1024,
    "height": 1024,
    "aspectRatio": "1:1",
    "maxReferenceImages": 10,
    "supportsGrounding": false
  },
  "apiKeyEnvVar": "BFL_API_KEY",
  "enabled": true
}
```

#### FLUX.2 [max] with Grounding Example

```json
{
  "id": "flux-2-max",
  "modelId": "flux-2-max",
  "name": {
    "en": "FLUX.2 Max",
    "de": "FLUX.2 Max"
  },
  "description": {
    "en": "Highest quality image generation with real-time grounding search. Perfect for final assets.",
    "de": "Höchste Qualität Bildgenerierung mit Echtzeit-Grounding-Suche. Perfekt für finale Assets."
  },
  "url": "https://api.bfl.ai/v1/flux-2-max",
  "provider": "bfl",
  "tokenLimit": 0,
  "supportsImageGeneration": true,
  "imageGeneration": {
    "width": 1024,
    "height": 1024,
    "aspectRatio": "1:1",
    "maxReferenceImages": 10,
    "supportsGrounding": true
  },
  "apiKeyEnvVar": "BFL_API_KEY",
  "enabled": true
}
```

### 6. Environment Variables

Add to `.env`:

```bash
# Black Forest Labs API Key
BFL_API_KEY=YOUR_API_KEY_HERE
```

## Implementation Challenges

### 1. Async to Sync Adaptation

**Challenge:** iHub Apps expects synchronous streaming responses, but BFL uses async polling.

**Solution:** 
- Implement polling within the adapter
- Return results once complete
- Use `processResponseBuffer` to indicate completion
- Stream status updates if possible

### 2. Image URL Handling

**Challenge:** BFL returns signed URLs that expire in 10 minutes.

**Solution:**
- Download image immediately in adapter
- Convert to base64
- Include in response as inline data
- Match existing image response format (similar to Google adapter)

### 3. Polling Strategy

**Challenge:** Efficient polling without overwhelming the API.

**Solution:**
- Exponential backoff: Start at 0.5s, max at 30s
- Configurable max retries
- Clear timeout handling
- Error handling for expired requests

### 4. Multi-Reference Images

**Challenge:** Supporting multiple reference images in prompts.

**Solution:**
- Extract images from message history
- Format according to BFL API spec
- Support up to model-specific limits (4-10 images)

## Integration with Existing Architecture

### Message Format

Input messages should support:
- Text prompt in `content`
- Optional reference images in `imageData` array
- Image editing context

### Response Format

Match existing image generation format (Google adapter):

```javascript
{
  content: ["Image generated successfully"],
  images: [{
    mimeType: "image/png",
    data: "base64_encoded_data",
    metadata: {
      model: "flux-2-pro",
      dimensions: { width: 1024, height: 1024 }
    }
  }],
  complete: true,
  finishReason: "stop"
}
```

## Testing Strategy

1. **Unit Tests:** Adapter methods (request building, polling, image download)
2. **Integration Tests:** Full generation flow with test API key
3. **Error Handling Tests:** Moderation, rate limits, invalid requests
4. **Model Tests:** Test each FLUX variant
5. **Performance Tests:** Polling efficiency, timeout handling

## Configuration Schema Updates

Update `server/validators/modelConfigSchema.js` to support BFL-specific options:

```javascript
imageGeneration: z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  aspectRatio: z.string().optional(),
  maxReferenceImages: z.number().optional(),
  supportsGrounding: z.boolean().optional(),
  safetyTolerance: z.number().min(0).max(6).optional()
}).optional()
```

## Security Considerations

1. **API Key Storage:** Use environment variables only
2. **URL Expiration:** Download immediately, don't store/expose signed URLs
3. **Content Moderation:** Respect BFL moderation responses
4. **Rate Limiting:** Implement client-side rate limiting to respect API limits
5. **Error Logging:** Don't log API keys or sensitive data

## Documentation Requirements

1. **Adapter Documentation:** How BFL adapter works
2. **Model Configuration Guide:** Setting up FLUX models
3. **User Guide:** Using image generation features
4. **API Key Setup:** How to obtain and configure BFL API keys
5. **Troubleshooting:** Common issues and solutions

## Future Enhancements

1. **Webhook Support:** Use webhooks instead of polling for production
2. **Regional Endpoint Selection:** Allow users to choose EU/US endpoints
3. **Advanced Features:**
   - Structured prompting support
   - Custom aspect ratios
   - Safety tolerance configuration per request
4. **Image Editing:** Support for FLUX.1 Kontext editing capabilities
5. **Batch Generation:** Support multiple images in single request

## References

- [BFL Quick Start](https://docs.bfl.ai/quick_start/generating_images)
- [BFL Integration Guidelines](https://docs.bfl.ai/api_integration/integration_guidelines)
- [BFL Error Handling](https://docs.bfl.ai/api_integration/errors)
- [FLUX.2 Overview](https://docs.bfl.ai/flux_2/flux2_overview)
- [FLUX.1 Kontext Overview](https://docs.bfl.ai/kontext/kontext_overview)
- [BFL Skills Integration](https://docs.bfl.ai/api_integration/skills_integration)

## Implementation Timeline

1. **Phase 1:** Create adapter and basic polling (Day 1)
2. **Phase 2:** Add model configurations and test (Day 1)
3. **Phase 3:** Error handling and edge cases (Day 2)
4. **Phase 4:** Documentation and examples (Day 2)
5. **Phase 5:** Testing and refinement (Day 3)

## Code Location

- **Adapter:** `/server/adapters/bfl.js`
- **Registry:** `/server/adapters/index.js`
- **Chat Service Integration:** `/server/services/chat/NonStreamingHandler.js`
- **Model Examples:** `/examples/models/flux-*.json`
- **App Example:** `/examples/apps/flux-image-generator.json`
- **Documentation:** `/docs/providers/bfl.md`
- **Concept:** `/concepts/2026-02-03 Black Forest Labs Image Generation.md`

## Implementation Summary

### Completed Features

✅ **BFL Adapter** (`server/adapters/bfl.js`)
- Async request submission to BFL API
- Polling mechanism with exponential backoff (0.5s to 5s)
- Image download from signed URLs
- Base64 conversion for client consumption
- Comprehensive error handling
- Content moderation support
- Rate limiting handling (429 errors)

✅ **Chat Service Integration**
- Modified `NonStreamingHandler` to detect BFL models
- Special `executeBFLGeneration` method for async polling
- Proper logging and usage tracking
- Error handling and user-friendly error messages
- Response formatting to match standard chat API

✅ **Model Configurations** (4 models)
1. **FLUX.2 Pro** - Production at scale
2. **FLUX.2 Max** - Highest quality with grounding search
3. **FLUX.2 Klein 4B** - Ultra-fast sub-second generation
4. **FLUX.1 Kontext Pro** - Image editing and character consistency

✅ **Example Application**
- Comprehensive FLUX image generator app
- Expert system prompts for image generation
- 5 starter prompts covering different use cases
- Multi-reference image upload support
- Best practices guidance built into prompts

✅ **Documentation**
- Provider setup guide
- Feature descriptions
- Best practices and prompt structure
- Troubleshooting guide
- Example use cases

### Technical Highlights

**Async Polling Strategy:**
```javascript
// Exponential backoff implementation
let delay = 500ms;           // Initial delay
let maxDelay = 5000ms;       // Maximum delay
let maxRetries = 120;        // 2 minutes max
```

**Image Download Flow:**
```
Submit → Poll (exponential backoff) → Download image → Convert to base64 → Return
```

**Error Handling:**
- HTTP errors (400, 402, 403, 422, 429, 500, 503)
- Content moderation (Request/Content Moderated)
- Task not found
- Timeout handling
- Rate limiting with retry logic

### Architecture Decisions

1. **Non-Streaming Only:** BFL uses async polling, incompatible with SSE streaming
2. **Polling in Adapter:** Keeps complexity isolated in adapter layer
3. **Base64 Conversion:** Immediate download and conversion prevents URL expiration
4. **Special Handler:** BFL detection in NonStreamingHandler for clean separation

### Testing Status

| Test Category | Status | Notes |
|---------------|--------|-------|
| Server Startup | ✅ Pass | Server starts without errors |
| Adapter Registration | ✅ Pass | BFL adapter registered correctly |
| Lint Compliance | ✅ Pass | No linting errors, only minor warnings |
| Integration Detection | ✅ Pass | NonStreamingHandler detects BFL models |
| Actual Generation | ⏸️ Pending | Requires BFL API key |
| Error Scenarios | ⏸️ Pending | Requires API access |
| Multi-Model Support | ⏸️ Pending | Requires API access |

### Known Limitations

1. **No Streaming Support** - BFL API is async, cannot stream real-time updates
2. **Generation Time** - 5-30 seconds depending on model (inherent to BFL)
3. **Image URL Expiration** - Must download immediately (handled automatically)
4. **Token Tracking** - BFL doesn't use tokens, usage tracked differently

### Future Enhancements

1. **Webhook Support** - Use BFL webhooks instead of polling for production
2. **Regional Endpoints** - Allow users to select EU/US endpoints via config
3. **Advanced Features:**
   - Structured prompting support
   - Custom aspect ratios in UI
   - Safety tolerance configuration per request
4. **Batch Generation** - Support multiple images in single request
5. **Progress Updates** - Stream status updates during polling
6. **Caching** - Cache generated images to reduce API calls

## Security Considerations Implemented

✅ **API Key Storage** - Environment variables only, never in code
✅ **URL Download** - Immediate download, no storage of signed URLs  
✅ **Content Moderation** - Respect BFL moderation responses  
✅ **Error Logging** - No API keys or sensitive data in logs  
✅ **Rate Limiting** - Client-side handling of 429 errors

## Deployment Checklist

- [ ] Add `BFL_API_KEY` to production environment variables
- [ ] Copy desired model configs from `examples/models/` to deployment
- [ ] Enable models by setting `"enabled": true`
- [ ] Optionally enable FLUX image generator app
- [ ] Test with actual BFL API key
- [ ] Monitor polling performance and adjust timeouts if needed
- [ ] Set up webhook endpoint for production (optional optimization)

## Conclusion

The Black Forest Labs FLUX integration is **complete and ready for testing**. The implementation follows iHub Apps architecture patterns, includes comprehensive error handling, and provides a user-friendly experience for image generation.

**Next Steps:**
1. Obtain BFL API key for testing
2. Test actual image generation flow
3. Validate error handling with various scenarios
4. Monitor performance and optimize polling if needed
5. Consider webhook implementation for production use
