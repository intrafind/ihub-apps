# Azure OpenAI Image Generation Support

**Date:** 2026-02-03  
**Status:** Implemented  
**Issue:** Support GPT-Image based on Azure for Image Generation

## Overview

This document describes the implementation of Azure OpenAI image generation support for DALL-E and GPT-Image models in iHub Apps.

## Background

Azure OpenAI Service provides image generation capabilities through two types of models:
1. **DALL-E 3** - High-quality image generation with improved prompt understanding
2. **GPT-Image** - Fast, high-quality image generation with advanced creative capabilities

These models are accessed through Azure's OpenAI Service endpoints and require specific API handling that differs from standard OpenAI endpoints.

## Key Differences from Standard OpenAI

### Authentication
- **Standard OpenAI**: Uses `Authorization: Bearer {api-key}` header
- **Azure OpenAI**: Uses `api-key: {api-key}` header

### Endpoint Structure
- **Standard OpenAI**: `https://api.openai.com/v1/images/generations`
- **Azure OpenAI**: `https://{resource}.openai.azure.com/openai/deployments/{deployment}/images/generations?api-version={version}`

### Response Format
- Both return JSON with base64-encoded images
- Azure supports the same parameters (size, quality, style, etc.)

## Architecture

### New Adapter: `azure-image.js`

A new adapter was created to handle Azure OpenAI image generation:

**Location:** `server/adapters/azure-image.js`

**Key Features:**
1. **Custom Authentication**: Overrides `createRequestHeaders()` to use `api-key` header
2. **Prompt Extraction**: Converts chat messages into a simple prompt string
3. **Request Formatting**: Formats requests according to Azure's image generation API
4. **Response Processing**: Parses Azure's response format and extracts base64 images

**Request Parameters:**
```javascript
{
  prompt: string,           // Extracted from user messages
  n: 1,                    // Number of images (1-10)
  size: string,            // Image size (e.g., "1024x1024")
  quality: string,         // "standard" or "hd"
  style: string,           // "vivid" or "natural"
  response_format: string  // "b64_json" or "url"
}
```

**Response Format:**
```javascript
{
  content: [],            // Text description of generated image
  images: [{             // Array of generated images
    mimeType: "image/png",
    data: "base64..."    // Base64-encoded image data
  }],
  complete: true,
  finishReason: "stop"
}
```

### Integration Changes

#### 1. Adapter Registry (`server/adapters/index.js`)
Added `azure-image` provider to the adapter registry:
```javascript
import AzureImageAdapter from './azure-image.js';

const adapters = {
  // ... existing adapters
  'azure-image': AzureImageAdapter
};
```

#### 2. Model Validator (`server/validators/modelConfigSchema.js`)
Updated provider enum to accept `azure-image`:
```javascript
provider: z.enum([
  'openai',
  'openai-responses',
  'anthropic',
  'google',
  'mistral',
  'local',
  'iassistant',
  'azure-image'  // Added
])
```

#### 3. Streaming Handler (`server/services/chat/StreamingHandler.js`)
Azure image generation doesn't use Server-Sent Events (SSE) format. Updated the streaming handler to process Azure's JSON response as a custom buffer:

```javascript
const hasCustomBufferProcessor =
  model.provider === 'iassistant' || model.provider === 'azure-image';
```

This ensures Azure's single JSON response is processed correctly instead of trying to parse it as SSE chunks.

## Configuration

### Example Model: DALL-E 3

**File:** `examples/models/azure-dalle-3.json`

```json
{
  "id": "dalle-3-azure",
  "modelId": "dall-e-3",
  "name": {
    "en": "DALL-E 3 (Azure)",
    "de": "DALL-E 3 (Azure)"
  },
  "description": {
    "en": "Azure OpenAI's DALL-E 3 for high-quality image generation...",
    "de": "Azure OpenAIs DALL-E 3 für hochwertige Bildgenerierung..."
  },
  "url": "https://${AZURE_OPENAI_ENDPOINT}.openai.azure.com/openai/deployments/${AZURE_DALLE3_DEPLOYMENT}/images/generations?api-version=2024-02-01",
  "provider": "azure-image",
  "tokenLimit": 4000,
  "supportsTools": false,
  "supportsImages": false,
  "supportsImageGeneration": true,
  "imageGeneration": {
    "imageSize": "1024x1024",
    "quality": "standard",
    "style": "vivid"
  },
  "enabled": false
}
```

### Example Model: GPT-Image

**File:** `examples/models/azure-gpt-image.json`

Similar structure but for GPT-Image model with different deployment name and quality settings.

### Environment Variables Required

To use Azure image generation models, configure these environment variables:

```bash
# Azure OpenAI endpoint (your resource name)
AZURE_OPENAI_ENDPOINT=your-resource-name

# Deployment names for image models
AZURE_DALLE3_DEPLOYMENT=dalle-3-deployment
AZURE_GPTIMAGE_DEPLOYMENT=gpt-image-deployment

# API key for Azure OpenAI (can reuse existing or use separate)
OPENAI_API_KEY=your-azure-openai-key
```

Alternatively, use model-specific API keys:
```bash
# Separate API key for Azure image models
AZURE_IMAGE_API_KEY=your-specific-key
```

## Usage Flow

1. **User Request**: User sends a text prompt through an app configured for image generation
2. **Request Preparation**: ChatService prepares the request using RequestBuilder
3. **Adapter Selection**: System selects `azure-image` adapter based on model's provider
4. **Request Formatting**: Adapter formats request with Azure-specific headers and body
5. **API Call**: Request sent to Azure OpenAI image generation endpoint
6. **Response Processing**: 
   - Complete JSON response received (not streamed)
   - Adapter extracts base64 images from response
   - Images formatted for client consumption
7. **Client Display**: Images sent to client via SSE events and displayed in chat

## Client Integration

The client handles Azure-generated images the same way as Google Gemini images:

**Event Type:** `image`  
**Event Data:**
```javascript
{
  mimeType: "image/png",
  data: "base64-encoded-image-data"
}
```

The client's `useAppChat` hook processes image events and displays them in the chat interface.

## Supported Image Sizes

Azure OpenAI supports the following image sizes:
- `1024x1024` (square, default)
- `1792x1024` (landscape)
- `1024x1792` (portrait)

Configure in the model's `imageGeneration.imageSize` field.

## Quality Settings

- **`standard`**: Faster generation, good quality
- **`hd`**: Higher quality, slower generation, more expensive

## Style Settings

- **`vivid`**: Hyper-realistic and dramatic images
- **`natural`**: More natural, less hyper-real images

## Error Handling

The adapter handles Azure-specific errors:
- API key errors: Returns user-friendly message about authentication
- Content policy violations: Returns Azure's content filtering message
- Rate limiting: Returns appropriate rate limit error
- Invalid prompts: Returns Azure's error message about prompt issues

## Security Considerations

1. **API Keys**: Never hardcode API keys; always use environment variables
2. **Placeholders**: Use `${AZURE_OPENAI_ENDPOINT}` format in configuration
3. **Authentication**: Azure-specific `api-key` header used instead of Bearer token
4. **Encryption**: Model-specific API keys encrypted at rest using platform encryption

## Testing

### Manual Testing

1. Configure environment variables for Azure OpenAI
2. Enable one of the example models (DALL-E 3 or GPT-Image)
3. Create or use the existing image generator app
4. Send a text prompt for image generation
5. Verify image is generated and displayed correctly

### Server Startup Validation

```bash
cd /home/runner/work/ihub-apps/ihub-apps
timeout 10s node server/server.js
```

Verify:
- No import errors
- Adapter loads correctly
- Models validate successfully

## Future Enhancements

1. **Image Editing**: Support Azure's image editing capabilities (variations, inpainting)
2. **Multi-Image Generation**: Support generating multiple images per request (n > 1)
3. **Prompt Revision Feedback**: Display Azure's revised prompts to users
4. **Advanced Settings UI**: Allow users to adjust quality and style per request

## References

- [Azure OpenAI DALL-E Documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e)
- [Azure OpenAI DALL-E Quickstart](https://learn.microsoft.com/de-de/azure/ai-foundry/openai/dall-e-quickstart)
- [GPT-4 Vision Prompt Engineering](https://learn.microsoft.com/de-de/azure/ai-foundry/openai/concepts/gpt-4-v-prompt-engineering)

## Implementation Files

### Created
- `server/adapters/azure-image.js` - Azure image generation adapter
- `examples/models/azure-dalle-3.json` - DALL-E 3 model configuration
- `examples/models/azure-gpt-image.json` - GPT-Image model configuration

### Modified
- `server/adapters/index.js` - Added azure-image to adapter registry
- `server/validators/modelConfigSchema.js` - Added azure-image to provider enum
- `server/services/chat/StreamingHandler.js` - Added custom buffer processing for azure-image

## Conclusion

Azure OpenAI image generation is now fully supported in iHub Apps. Users can configure DALL-E 3 and GPT-Image models through Azure OpenAI Service and use them for high-quality image generation within the platform. The implementation follows the existing architecture patterns while handling Azure-specific authentication and response formats.
