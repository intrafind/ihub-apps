# Image Generation Feature

iHub Apps now supports AI-powered image generation using models like OpenAI's DALL-E. Users can generate creative images from text descriptions directly within the chat interface.

## Overview

The image generation feature allows users to:
- Generate images from text prompts
- Download generated images
- Use different image generation models (DALL-E 2, DALL-E 3, etc.)
- Customize image parameters (size, quality, style)

## Supported Models

### OpenAI DALL-E 3
- **High-quality** image generation
- Improved prompt understanding
- Sizes: 1024x1024, 1792x1024, 1024x1792
- Quality: standard, hd
- Style: vivid, natural

### OpenAI DALL-E 2
- **Fast and cost-effective**
- Sizes: 256x256, 512x512, 1024x1024

## Configuration

### API Key Setup

Add your OpenAI API key to the `.env` file:

```bash
OPENAI_API_KEY=sk-...
```

### Enable Image Generation Models

Edit the model configuration files in `contents/models/`:

**For DALL-E 3** (`dall-e-3.json`):
```json
{
  "id": "dall-e-3",
  "enabled": true
}
```

**For DALL-E 2** (`dall-e-2.json`):
```json
{
  "id": "dall-e-2",
  "enabled": true
}
```

### Create an Image Generation App

An example app is provided at `server/defaults/apps/image-generator.json`. To enable it:

1. Navigate to Admin > Apps
2. Find "Image Generator"
3. Click "Enable"

Or create your own image generation app:

```json
{
  "id": "my-image-gen",
  "name": {
    "en": "My Image Generator",
    "de": "Mein Bildgenerator"
  },
  "description": {
    "en": "Generate creative images",
    "de": "Generiere kreative Bilder"
  },
  "color": "#8B5CF6",
  "icon": "image",
  "system": {
    "en": "You are an AI image generation assistant.",
    "de": "Du bist ein KI-Bildgenerierungsassistent."
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

## Usage

### Basic Usage

1. Open the Image Generator app from the home screen
2. Enter a text description of the image you want to generate
3. Press Enter or click Send
4. Wait for the image to be generated
5. Download the image using the Download button

### Example Prompts

**Simple prompts:**
- "A sunset over mountains"
- "A cute robot in a garden"
- "Abstract geometric patterns in blue and gold"

**Detailed prompts:**
- "A photorealistic image of a cozy coffee shop interior with warm lighting, wooden furniture, and people reading books, in the style of a professional photograph"
- "A fantasy illustration of a dragon flying over a medieval castle at night, with a full moon in the background, digital art style"

### Image Parameters

You can configure default parameters in the app's `imageGenerationOptions`:

- **size**: Image dimensions
  - DALL-E 3: `1024x1024`, `1792x1024`, `1024x1792`
  - DALL-E 2: `256x256`, `512x512`, `1024x1024`
- **quality**: Image quality (DALL-E 3 only)
  - `standard`: Default quality
  - `hd`: Higher quality (more expensive)
- **style**: Image style (DALL-E 3 only)
  - `vivid`: More dramatic, artistic
  - `natural`: More realistic, natural
- **n**: Number of images to generate (1-10)

## Technical Details

### Architecture

Image generation uses a specialized architecture:

1. **ImageGenerationAdapter**: Handles API calls to image generation services
2. **ImageGenerationHandler**: Processes requests and sends responses via SSE
3. **Model Configuration**: Defines image generation models with type `"image-generation"`
4. **Client Rendering**: ChatMessage component displays images inline

### API Flow

```
User Input → App Config → Request Builder → Image Generation Handler
                                                     ↓
                                              OpenAI DALL-E API
                                                     ↓
                                              Image URLs/Data
                                                     ↓
                                              SSE 'done' Event
                                                     ↓
                                              Client Display
```

### Response Format

The server sends image data via Server-Sent Events (SSE):

```json
{
  "type": "image",
  "images": [
    {
      "url": "https://...",
      "revised_prompt": "Detailed prompt used by DALL-E",
      "format": "png",
      "isBase64": false
    }
  ],
  "finishReason": "stop"
}
```

## Troubleshooting

### No Images Generated

**Check API Key:**
- Ensure `OPENAI_API_KEY` is set in `.env`
- Verify the API key is valid and has credits

**Check Model Status:**
- Ensure the image generation model is enabled
- Check the Admin > Models page

**Check App Configuration:**
- Ensure `preferredModel` points to an image generation model
- Verify `imageGenerationOptions` is configured correctly

### Error Messages

**"API key not found":**
- Add `OPENAI_API_KEY` to your `.env` file

**"Model not found":**
- Enable the DALL-E model in Admin > Models

**"Request timed out":**
- Image generation can take 10-30 seconds
- Increase `REQUEST_TIMEOUT` in `config.env` if needed

### Image Quality Issues

**Images don't match prompt:**
- Use more detailed descriptions
- DALL-E 3 has better prompt understanding than DALL-E 2
- Check the "revised prompt" to see how DALL-E interpreted your request

**Images are low quality:**
- For DALL-E 3, set `quality: "hd"` in `imageGenerationOptions`
- Use larger sizes (1792x1024 or 1024x1792)

## Advanced Configuration

### Multiple Image Generation Apps

You can create multiple apps with different default settings:

**Quick Sketch** (fast, lower quality):
```json
{
  "preferredModel": "dall-e-2",
  "imageGenerationOptions": {
    "size": "512x512"
  }
}
```

**High Quality Art** (slow, higher quality):
```json
{
  "preferredModel": "dall-e-3",
  "imageGenerationOptions": {
    "size": "1792x1024",
    "quality": "hd",
    "style": "vivid"
  }
}
```

### Custom System Prompts

Use system prompts to guide users:

```json
{
  "system": {
    "en": "You are an expert AI image generation assistant. Help users craft effective prompts by suggesting details like lighting, style, mood, composition, and artistic techniques. When users provide simple descriptions, offer to expand them into detailed prompts for better results."
  }
}
```

### Integration with Other Apps

Image generation can be combined with other features:
- Use web search tools to research image styles
- Use file upload to analyze reference images (requires vision-capable models)
- Chain image generation with other creative apps

## Future Enhancements

Planned features for future releases:
- Image editing (variations, inpainting, outpainting)
- Support for Google Imagen
- Support for Stable Diffusion (self-hosted)
- Image-to-image generation
- Batch generation
- Gallery view for generated images

## Cost Considerations

Image generation incurs API costs:

**DALL-E 3:**
- Standard 1024×1024: ~$0.040 per image
- HD 1024×1024: ~$0.080 per image
- Standard 1792×1024 or 1024×1792: ~$0.080 per image
- HD 1792×1024 or 1024×1792: ~$0.120 per image

**DALL-E 2:**
- 256×256: ~$0.016 per image
- 512×512: ~$0.018 per image
- 1024×1024: ~$0.020 per image

Check OpenAI's [pricing page](https://openai.com/pricing) for current rates.

## Security & Privacy

- Images are not stored on the iHub Apps server
- Image URLs from OpenAI expire after a certain time
- Users should download images they want to keep
- Never include personal or sensitive information in prompts
- Follow OpenAI's usage policies and content guidelines

## Support

For issues or questions:
- Check the [main documentation](../README.md)
- Visit the [GitHub repository](https://github.com/intrafind/ihub-apps)
- Contact support via the configured channels
