# Image Generation Support - Step 1

**Date**: 2026-01-13  
**Status**: Completed  
**Related Issue**: Support Images - Step 1: Image Generation

## Overview

This concept document outlines the implementation plan for adding image generation capabilities to iHub Apps. The feature allows users to generate images from text prompts using models like OpenAI's DALL-E, Azure OpenAI DALL-E, and Google's Imagen.

## Goals

1. Enable users to generate images from text prompts within the chat interface
2. Display generated images inline in the chat
3. Provide download functionality for generated images
4. Support multiple image generation providers:
   - OpenAI DALL-E (2 and 3)
   - Azure OpenAI DALL-E
   - Google Imagen (Nano Banana)
5. Maintain consistency with the existing architecture and adapter pattern

## Architecture

### Adapter Pattern

The implementation follows the existing adapter pattern used for LLM providers. However, image generation requires a different approach:

**Key Differences from Chat Adapters:**
- Image generation APIs use different endpoints (e.g., `/v1/images/generations` for OpenAI)
- Request format differs (prompt instead of messages array)
- Response contains image URLs or base64 data instead of text streaming
- No support for chat history or system prompts

### Implementation Strategy

We will create a specialized image generation adapter that:
1. Accepts a text prompt and generation parameters (size, quality, style)
2. Sends requests to the appropriate image generation API
3. Returns image URLs or base64-encoded image data
4. Handles errors appropriately

## Technical Design

### 1. Image Generation Adapter

**Location**: `server/adapters/imageGeneration.js`

**Key Features:**
- Separate adapter class for image generation
- Support for multiple providers (OpenAI, Google, Stable Diffusion)
- Handle provider-specific request/response formats
- Return structured image data with metadata

**API Structure:**
```javascript
{
  createImageRequest(model, prompt, options) {
    // Returns: { url, method, headers, body }
  },
  processImageResponse(provider, response) {
    // Returns: { images: [{ url, format, size }], metadata }
  }
}
```

### 2. Model Configuration

**Location**: `server/defaults/models/`

**Example Models:**
- `dall-e-3.json` - OpenAI DALL-E 3 (high quality)
- `dall-e-2.json` - OpenAI DALL-E 2 (faster, cheaper)
- `imagen-3.json` - Google Imagen 3
- `stable-diffusion.json` - Self-hosted Stable Diffusion

**Model Schema:**
```json
{
  "id": "dall-e-3",
  "modelId": "dall-e-3",
  "name": { "en": "DALL-E 3", "de": "DALL-E 3" },
  "description": {
    "en": "High-quality image generation from OpenAI",
    "de": "Hochwertige Bildgenerierung von OpenAI"
  },
  "url": "https://api.openai.com/v1/images/generations",
  "provider": "openai-image",
  "type": "image-generation",
  "supportsTools": false,
  "enabled": false,
  "default": false,
  "imageGeneration": {
    "supportedSizes": ["1024x1024", "1792x1024", "1024x1792"],
    "supportedQualities": ["standard", "hd"],
    "supportedStyles": ["vivid", "natural"],
    "maxPromptLength": 4000
  }
}
```

### 3. Response Handling

**Server-side Changes:**
- Detect when a model is an image generation model (via `type: "image-generation"`)
- Route to image generation handler instead of chat handler
- Return image data in a structured format

**Response Format:**
```json
{
  "type": "image",
  "images": [
    {
      "url": "https://...",
      "revised_prompt": "...",
      "format": "png",
      "size": "1024x1024"
    }
  ],
  "metadata": {
    "model": "dall-e-3",
    "timestamp": "2026-01-13T14:00:00Z"
  }
}
```

### 4. Client-side Updates

**Components to Update:**
- `ChatMessage.jsx` - Display images in chat messages
- `ChatInput.jsx` - Add image generation parameters UI (optional)
- `useAppChat.js` - Handle image generation responses

**Image Display:**
- Show images inline in the chat
- Add loading state while image is being generated
- Display error messages if generation fails
- Provide download button for each image

### 5. App Configuration

**Location**: `server/defaults/apps/image-generator.json`

**Example App:**
```json
{
  "id": "image-generator",
  "name": {
    "en": "Image Generator",
    "de": "Bildgenerator"
  },
  "description": {
    "en": "Generate images from text descriptions",
    "de": "Generiere Bilder aus Textbeschreibungen"
  },
  "color": "#8B5CF6",
  "icon": "image",
  "system": {
    "en": "You are an AI image generation assistant. Help users create detailed prompts for image generation.",
    "de": "Du bist ein KI-Bildgenerierungsassistent. Hilf Nutzern, detaillierte Prompts für die Bildgenerierung zu erstellen."
  },
  "preferredModel": "dall-e-3",
  "imageGenerationOptions": {
    "size": "1024x1024",
    "quality": "standard",
    "style": "vivid"
  },
  "enabled": true
}
```

## Implementation Steps

1. **Create Image Generation Adapter**
   - File: `server/adapters/imageGeneration.js`
   - Implement OpenAI DALL-E adapter first
   - Add to adapter registry

2. **Create Model Configurations**
   - File: `server/defaults/models/dall-e-3.json`
   - File: `server/defaults/models/dall-e-2.json`
   - Add image generation specific fields

3. **Update Route Handling**
   - Detect image generation models
   - Route to appropriate handler
   - Return image data in response

4. **Update Client Components**
   - Update `ChatMessage.jsx` to render images
   - Add download functionality
   - Handle loading states

5. **Create Example App**
   - File: `server/defaults/apps/image-generator.json`
   - Configure for DALL-E 3

6. **Add Internationalization**
   - Add translations for image generation UI elements
   - Update `shared/i18n/en.json` and `shared/i18n/de.json`

7. **Testing**
   - Test image generation with OpenAI DALL-E
   - Verify images display correctly
   - Test download functionality
   - Ensure error handling works

## API Key Management

Image generation models will use the same API key management as existing models:
- OpenAI DALL-E: Use `OPENAI_API_KEY` environment variable
- Google Imagen: Use `GOOGLE_API_KEY` environment variable
- Self-hosted: Use custom endpoint with optional API key

## Security Considerations

1. **Input Validation**: Validate prompt length and content
2. **Rate Limiting**: Apply rate limiting to prevent abuse
3. **Content Filtering**: Respect provider content policies
4. **API Key Security**: Never expose API keys in responses or logs

## Future Enhancements (Out of Scope for Step 1)

- Image editing capabilities
- Image variations
- Inpainting/outpainting
- Multiple image generation per request
- Custom parameter controls in UI
- Image storage and gallery view

## Code Locations

### Server
- **Adapter**: `server/adapters/imageGeneration.js`
- **Models**: `server/defaults/models/dall-e-*.json`
- **Apps**: `server/defaults/apps/image-generator.json`
- **Routes**: `server/routes/chat/sessionRoutes.js` (modifications)

### Client
- **Message Display**: `client/src/features/chat/components/ChatMessage.jsx`
- **Hooks**: `client/src/features/chat/hooks/useAppChat.js`

### Shared
- **Translations**: `shared/i18n/en.json`, `shared/i18n/de.json`

## Success Criteria

1. ✅ Users can send a text prompt and receive a generated image
2. ✅ Images display correctly in the chat interface
3. ✅ Users can download generated images
4. ✅ Error messages are clear and helpful
5. ✅ Feature works with OpenAI DALL-E models
6. ✅ Code follows existing architecture patterns
7. ✅ All strings are internationalized
8. ✅ Feature is documented

## Notes

- This is Step 1 focusing on basic image generation
- Follow the existing adapter pattern for consistency
- Maintain separation between chat and image generation
- Consider using a flag on models to distinguish image generation from chat
