# Azure OpenAI Image Generation Configuration Guide

This directory contains example configurations for Azure OpenAI image generation models.

## Available Models

### DALL-E 3 (azure-dalle-3.json)
High-quality image generation with improved prompt understanding. Best for:
- Detailed, artistic images
- Complex scene compositions
- Professional asset creation

### GPT-Image (azure-gpt-image.json)
Fast, high-quality image generation with advanced creative capabilities. Best for:
- Quick prototyping
- Iterative image refinement
- General-purpose image generation

## Setup Instructions

### 1. Create Azure OpenAI Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Create an "Azure OpenAI" resource
3. Deploy a DALL-E 3 or GPT-Image model to your resource
4. Note your:
   - Resource endpoint (e.g., `my-resource.openai.azure.com`)
   - Deployment name (e.g., `dalle-3`)
   - API key

### 2. Configure Environment Variables

Add to your `.env` or `config.env` file:

```bash
# Azure OpenAI endpoint (your resource name)
AZURE_OPENAI_ENDPOINT=your-resource-name

# Deployment names for your image models
AZURE_DALLE3_DEPLOYMENT=your-dalle3-deployment-name
AZURE_GPTIMAGE_DEPLOYMENT=your-gptimage-deployment-name

# API key (reuse existing OPENAI_API_KEY or create separate)
OPENAI_API_KEY=your-azure-openai-api-key
```

### 3. Copy and Enable Model Configuration

Copy the example model configuration to your `contents/models/` directory:

```bash
# For DALL-E 3
cp examples/models/azure-dalle-3.json contents/models/

# For GPT-Image
cp examples/models/azure-gpt-image.json contents/models/
```

Edit the copied file and set `"enabled": true`.

### 4. Restart Server

Restart the iHub Apps server to load the new model configuration.

## Configuration Options

### Image Size
Supported sizes:
- `1024x1024` - Square (default)
- `1792x1024` - Landscape
- `1024x1792` - Portrait

Configure in model's `imageGeneration.imageSize` field.

### Quality
- `standard` - Faster, good quality
- `hd` - Higher quality, slower, more expensive

### Style
- `vivid` - Hyper-realistic and dramatic
- `natural` - More natural, less stylized

## Using with Image Generator App

1. Make sure you have an image generation app configured
2. The default `image-generator` app works out of the box
3. The app should have:
   - `settings.model.filter.supportsImageGeneration: true`
   - Image upload enabled for editing capabilities

## Troubleshooting

### "Missing API key" error
- Check that environment variables are set correctly
- Verify `.env` file is in the repository root
- Make sure to restart server after changing environment variables

### "Deployment not found" error
- Verify deployment name matches your Azure deployment
- Check that the model is deployed and active in Azure Portal

### Images not displaying
- Check browser console for errors
- Verify the response contains base64 image data
- Check that client is receiving image events properly

## Cost Considerations

Azure OpenAI image generation is billed per image:
- **Standard quality**: ~$0.04 per image
- **HD quality**: ~$0.08 per image

Monitor your Azure OpenAI usage in the Azure Portal to track costs.

## API Version

The example configurations use API version `2024-02-01`. You can update this in the model URL if newer versions become available:

```json
"url": "https://${AZURE_OPENAI_ENDPOINT}.openai.azure.com/openai/deployments/${AZURE_DALLE3_DEPLOYMENT}/images/generations?api-version=2024-02-01"
```

## Further Reading

- [Azure OpenAI Image Generation Documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e)
- [DALL-E Quickstart Guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/dall-e-quickstart)
- [Pricing Information](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/)
