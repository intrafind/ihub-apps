# Test Suite Configuration Guide

This guide explains how to configure the test suite for different LLM providers and deployment scenarios.

## Environment Variables

### API Keys (Required for real API calls)

```bash
export OPENAI_API_KEY="your-openai-key"
export ANTHROPIC_API_KEY="your-anthropic-key"
export GOOGLE_API_KEY="your-google-key"
export MISTRAL_API_KEY="your-mistral-key"
```

### Base URLs (Optional - defaults to official APIs)

```bash
# OpenAI (supports Azure OpenAI)
export OPENAI_BASE_URL="https://api.openai.com/v1/chat/completions"
# For Azure OpenAI:
export OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2023-12-01-preview"

# Anthropic
export ANTHROPIC_BASE_URL="https://api.anthropic.com/v1/messages"

# Google
export GOOGLE_BASE_URL="https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"

# Mistral
export MISTRAL_BASE_URL="https://api.mistral.ai/v1/chat/completions"
```

### Model IDs (Optional - uses defaults if not specified)

```bash
export OPENAI_MODEL_ID="gpt-4o-mini"
export ANTHROPIC_MODEL_ID="claude-3-haiku-20240307"
export GOOGLE_MODEL_ID="gemini-1.5-flash"
export MISTRAL_MODEL_ID="mistral-small-latest"
```

## Azure OpenAI Configuration

For Azure OpenAI deployments, you need to set:

```bash
export OPENAI_API_KEY="your-azure-openai-key"
export OPENAI_BASE_URL="https://your-resource.openai.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2023-12-01-preview"
export OPENAI_MODEL_ID="your-deployment-name"
```

Example for the current .env configuration:

```bash
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://engineeringaih8479606976.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview"
export OPENAI_MODEL_ID="gpt-4.1"
```

## Running Tests

### Basic tests (no API calls)

```bash
npm run test:all
```

### Individual provider tests

```bash
npm run test:openai
npm run test:anthropic
npm run test:google
npm run test:mistral
```

### Tool calling consistency tests

```bash
node server/tests/toolCalling.test.js
node server/tests/toolCallingIntegration.test.js
node server/tests/toolCallingFixes.js
```

### Real LLM integration test (requires API keys)

```bash
node server/tests/real-llm-integration.test.js
```

## Test Files Overview

- **`toolCalling.test.js`** - Tests tool formatting, message handling, and response processing
- **`toolCallingIntegration.test.js`** - Tests high-level adapter integration and request creation
- **`toolCallingFixes.js`** - Demonstrates unified interfaces to solve provider inconsistencies
- **`real-llm-integration.test.js`** - Makes actual API calls to test real LLM behavior
- **Individual adapter tests** - Test specific provider implementations

## Expected Test Behavior

### Without API Keys

- Tests will show configuration and skip API calls
- Request generation and formatting tests will still pass
- Tool calling structure tests will pass

### With API Keys

- Tests will make actual API calls
- Tool calling behavior will be tested end-to-end
- Rate limiting is applied between requests

## Troubleshooting

### Azure OpenAI Issues

- Ensure your deployment name matches the model ID
- Check that the API version is correct
- Verify the resource URL format
- Make sure the API key has proper permissions

### Tool Loading Issues

- Check that tools are properly configured in your application
- Verify the tool cache is initialized
- Ensure tool definitions follow the expected schema

### Rate Limiting

- The real integration test includes 1-second delays between requests
- Adjust the delay in `real-llm-integration.test.js` if needed
- Some providers have stricter rate limits than others
