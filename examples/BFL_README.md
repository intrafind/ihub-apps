# BFL FLUX Image Generation - Implementation README

## Quick Start

### 1. Add API Key

```bash
# Add to .env file
BFL_API_KEY=YOUR_API_KEY_HERE
```

### 2. Enable a Model

```bash
# Copy example model configuration
cp examples/models/flux-2-pro.json contents/models/

# Edit the file and set enabled: true
```

### 3. Start Server

```bash
npm run dev
```

### 4. Test Image Generation

Use the FLUX image generator app or any app configured to use BFL models.

## Available Models

| Model | File | Best For |
|-------|------|----------|
| FLUX.2 Pro | `flux-2-pro.json` | Production at scale |
| FLUX.2 Max | `flux-2-max.json` | Highest quality + grounding |
| FLUX.2 Klein 4B | `flux-2-klein-4b.json` | Ultra-fast generation |
| FLUX.1 Kontext Pro | `flux-kontext-pro.json` | Image editing |

## Example App

Enable the FLUX image generator app:

```bash
cp examples/apps/flux-image-generator.json contents/apps/
# Edit and set enabled: true
```

This app includes:
- Expert system prompts
- 5 starter prompts
- Multi-reference image upload
- Best practices guidance

## Architecture

```
User Request
    ↓
NonStreamingHandler (detects BFL provider)
    ↓
BFL Adapter
    ↓
Submit → Poll → Download → Convert to Base64
    ↓
Return to User
```

## Files Modified

- `server/adapters/bfl.js` - BFL adapter implementation
- `server/adapters/index.js` - Registered BFL adapter
- `server/services/chat/NonStreamingHandler.js` - Added BFL detection
- `.env.example` - Added BFL_API_KEY

## Files Added

- `examples/models/flux-2-pro.json` - FLUX.2 Pro model config
- `examples/models/flux-2-max.json` - FLUX.2 Max model config
- `examples/models/flux-2-klein-4b.json` - FLUX.2 Klein 4B config
- `examples/models/flux-kontext-pro.json` - FLUX.1 Kontext Pro config
- `examples/apps/flux-image-generator.json` - Example app
- `docs/providers/bfl.md` - Provider documentation
- `concepts/2026-02-03 Black Forest Labs Image Generation.md` - Concept doc

## Key Features

✅ Async polling with exponential backoff
✅ Automatic image download and base64 conversion
✅ Error handling for all BFL error types
✅ Content moderation support
✅ Rate limiting with retry logic
✅ Multi-reference image support

## Testing

```bash
# Test server startup
npm run lint:fix
timeout 5s node server/server.js

# For actual generation testing, you need a valid BFL API key
```

## Troubleshooting

**Problem:** Images not generating
**Solution:** 
1. Check API key is set in .env
2. Verify model is enabled
3. Check server logs for errors
4. Ensure sufficient API credits

**Problem:** Slow generation
**Solution:** This is normal. BFL uses async polling (5-30 seconds).

**Problem:** Content moderated error
**Solution:** Adjust your prompt or increase safety_tolerance in model config.

## Resources

- [BFL Documentation](https://docs.bfl.ai)
- [Provider Guide](../docs/providers/bfl.md)
- [Concept Document](../concepts/2026-02-03 Black Forest Labs Image Generation.md)

## Support

For issues:
1. Check server logs
2. Review BFL documentation
3. Check concept document for architecture details
4. Open issue in GitHub repository
