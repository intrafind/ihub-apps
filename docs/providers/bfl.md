# Black Forest Labs (BFL) FLUX Image Generation

## Overview

iHub Apps now supports Black Forest Labs FLUX models for state-of-the-art image generation. FLUX offers multiple models optimized for different use cases, from ultra-fast real-time generation to highest-quality final assets.

## Available Models

### FLUX.2 Family (Latest Generation)

| Model | ID | Speed | Best For |
|-------|-----|-------|----------|
| **FLUX.2 Klein 4B** | `flux-2-klein-4b` | Sub-second | High-volume, real-time applications |
| **FLUX.2 Pro** | `flux-2-pro` | ~5 seconds | Production at scale |
| **FLUX.2 Max** | `flux-2-max` | ~6 seconds | Highest quality + grounding search |

### FLUX.1 Kontext Family (Image Editing)

| Model | ID | Best For |
|-------|-----|----------|
| **FLUX.1 Kontext Pro** | `flux-kontext-pro` | Text-to-image, image editing, character consistency |

## Setup

### 1. Get API Key

1. Sign up at [bfl.ai](https://bfl.ai)
2. Get your API key from the dashboard
3. Add to your `.env` file:

```bash
BFL_API_KEY=YOUR_API_KEY_HERE
```

### 2. Enable Models

Copy model configurations from `examples/models/` to your deployment and enable them.

### 3. Configure App

Optionally, enable the example FLUX image generator app from `examples/apps/flux-image-generator.json`.

## Features

- **Text-to-Image Generation**: Photorealistic images, typography, detailed textures
- **Multi-Reference Images**: Up to 4-10 reference images for consistency
- **Hex Color Control**: Specify exact colors using `#RRGGBB` format
- **Grounding Search**: Real-time web information (FLUX.2 Max only)
- **Typography**: Reliable text rendering in images

## Best Practices

### Prompt Structure

```
[Subject] + [Action] + [Style] + [Context] + [Lighting] + [Technical]
```

### What NOT to Do

❌ Don't use negative prompts - FLUX doesn't support them  
❌ Don't be vague - Specific details produce better results  
❌ Don't expect instant results - Generation takes 5-30 seconds

✅ Do describe what you want - Not what you don't want  
✅ Do be specific - Include details about lighting, style, composition  
✅ Do use reference images - For consistency and character preservation

## Resources

- [BFL Documentation](https://docs.bfl.ai)
- [FLUX.2 Overview](https://docs.bfl.ai/flux_2/flux2_overview)
- [Best Practices Guide](https://docs.bfl.ai/api_integration/skills_integration)
