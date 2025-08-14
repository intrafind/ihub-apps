# Local LLM Providers Integration Guide

This comprehensive guide covers how to integrate local LLM providers (LM Studio, Jan.ai, and vLLM) with iHub Apps for privacy-focused, offline AI capabilities.

## Overview

iHub Apps supports local LLM providers through OpenAI-compatible APIs, enabling:
- **Complete Privacy**: Models run entirely on your hardware
- **Offline Operation**: No internet connection required for inference
- **Cost-Free**: No API usage fees
- **Model Flexibility**: Use any GGUF/GGML compatible models
- **Hardware Control**: Optimize for your specific hardware setup

## Provider Comparison

| Feature | LM Studio | Jan.ai | vLLM |
|---------|-----------|---------|------|
| **Installation** | Desktop App | Desktop App | Python Package |
| **Default Port** | 1234 | 1337 | 8000 |
| **API Endpoint** | `/v1/chat/completions` | `/v1/chat/completions` | `/v1/chat/completions` |
| **Streaming Support** | ✅ | ✅ | ✅ |
| **Tool/Function Calling** | ✅ | ✅ (MCP Experimental) | ✅ (with --enable-auto-tool-choice) |
| **Structured Output** | ✅ | ❌ | ✅ |
| **Vision Models** | ✅ | ❌ | ✅ |
| **Embeddings** | ✅ | ✅ | ✅ |
| **Model Management** | GUI | GUI | CLI/API |
| **Performance Optimization** | Automatic | Automatic | Manual Configuration |
| **Multi-Model Support** | ✅ | Limited | ✅ |

---

## LM Studio Integration

### Desktop Application Setup

1. **Download and Install LM Studio**
   ```bash
   # Visit https://lmstudio.ai and download for your platform
   # Available for Windows, macOS, and Linux
   ```

2. **Download Models**
   - Open LM Studio
   - Go to "Search" tab
   - **Recommended models:**
     - **gpt-oss** (GPT-4 class performance, optimized for tool calling)
     - **mistralai/Mistral-Small-Instruct-2409** (Mistral Small 3.2, compact yet powerful)
     - **microsoft/Phi-3-medium-4k-instruct** (Efficient for most tasks)
   - Models are stored locally in GGUF format

3. **Start the Local Server**
   - Switch to "Developer" tab
   - Click "Start Server"
   - Default endpoint: `http://localhost:1234`
   - Server logs show loaded models and status

### CLI Setup (lms command)

1. **Install LM Studio CLI**
   ```bash
   # Download from GitHub releases or use LM Studio installer
   # The CLI tool 'lms' provides programmatic access
   ```

2. **Start Server via CLI**
   ```bash
   # Start server with recommended model
   lms server start --model "gpt-oss"
   
   # Start with Mistral Small for tool calling
   lms server start --model "mistralai/Mistral-Small-Instruct-2409" --port 8080
   
   # List available models
   lms ls
   ```

### iHub Apps Configuration

Create model configuration file `contents/models/lm-studio.json`:

```json
{
  "id": "lm-studio-gpt-oss",
  "modelId": "gpt-oss",
  "name": {
    "en": "GPT-OSS (LM Studio)",
    "de": "GPT-OSS (LM Studio)"
  },
  "description": {
    "en": "High-performance local LLM via LM Studio with excellent tool calling support",
    "de": "Hochleistungs-lokales LLM über LM Studio mit ausgezeichneter Tool-Calling-Unterstützung"
  },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 8192,
  "supportsTools": true,
  "supportsImages": true,
  "enabled": true,
  "default": false
}
```

### Environment Configuration

```bash
# Set API key (can be any value for LM Studio)
export OPENAI_API_KEY="lm-studio"

# Optional: Custom endpoint if using different port
export LM_STUDIO_ENDPOINT="http://localhost:1234"
```

### Advanced LM Studio Features

#### Multiple Model Configurations

```json
// contents/models/lm-studio-gpt-oss.json
{
  "id": "lm-studio-gpt-oss",
  "modelId": "gpt-oss",
  "name": { "en": "GPT-OSS (LM Studio)" },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 8192,
  "supportsTools": true
}

// contents/models/lm-studio-mistral.json
{
  "id": "lm-studio-mistral",
  "modelId": "mistralai/Mistral-Small-Instruct-2409",
  "name": { "en": "Mistral Small 3.2 (LM Studio)" },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 32768,
  "supportsTools": true
}
```

#### Performance Tuning

- **GPU Layers**: Configure GPU offloading in LM Studio settings
- **Context Length**: Adjust based on your hardware capabilities
- **Batch Size**: Optimize for your specific use case
- **Quantization**: Use 4-bit or 8-bit models for faster inference

---

## Jan.ai Integration

### Desktop Application Setup

1. **Download and Install Jan.ai**
   ```bash
   # Visit https://jan.ai and download for your platform
   # Open-source alternative with privacy focus
   ```

2. **Download Models**
   - Open Jan application
   - Browse model hub and download desired models
   - Models stored locally with automatic optimization

3. **Configure API Server**
   - Navigate to Settings → Local API Server
   - Set custom API key (e.g., `jan-local-key-123`)
   - Configure host (`127.0.0.1` for local only, `0.0.0.0` for network access)
   - Enable CORS if needed for web applications
   - Click "Start Server"

### Tool Calling with MCP (Experimental)

Jan.ai supports tool calling through the Model Context Protocol (MCP):

1. **Enable MCP Support**
   - Go to Settings → General → Advanced
   - Toggle "Allow All MCP Tool Permission" ON
   - Requires NodeJS and/or Python installed

2. **Configure MCP Servers**
   - Navigate to Settings → MCP Servers
   - Add MCP-compatible tool servers
   - Popular MCP tools: file system, web search, databases

3. **Recommended Models for Tool Calling**
   - **gpt-oss** (GPT-4 class performance with excellent tool calling)
   - **mistralai/Mistral-Small-Instruct-2409** (Mistral Small 3.2, optimized for function calling)
   - **microsoft/Phi-3-medium-4k-instruct** (Efficient model with good tool support)
   - Models specifically trained for function calling

### iHub Apps Configuration

Create model configuration `contents/models/jan-ai.json`:

```json
{
  "id": "jan-ai-mistral",
  "modelId": "mistralai/Mistral-Small-Instruct-2409",
  "name": {
    "en": "Mistral Small 3.2 (Jan.ai)",
    "de": "Mistral Small 3.2 (Jan.ai)"
  },
  "description": {
    "en": "Privacy-focused Mistral Small with MCP tool support",
    "de": "Datenschutzorientiertes Mistral Small mit MCP-Tool-Unterstützung"
  },
  "url": "http://localhost:1337/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 32768,
  "supportsTools": true,
  "supportsImages": false,
  "enabled": true,
  "default": false
}
```

### Environment Configuration

```bash
# Set the API key you configured in Jan.ai
export OPENAI_API_KEY="jan-local-key-123"

# Optional: Custom endpoint
export JAN_API_ENDPOINT="http://localhost:1337"
```

### Network Configuration

For multi-device access:

```bash
# In Jan.ai settings, set host to 0.0.0.0
# Then access from other devices using your machine's IP:
# http://192.168.1.100:1337/v1/chat/completions
```

### Security Considerations

- **API Key**: Always use a secure API key in production
- **Network Access**: Limit to trusted networks when using 0.0.0.0
- **CORS**: Enable only for trusted domains
- **MCP Permissions**: Review each MCP tool before enabling

---

## vLLM Integration

vLLM is a high-performance inference server optimized for serving large language models at scale.

### Installation

#### Docker Setup (Recommended)

```bash
# Pull vLLM Docker image
docker pull vllm/vllm-openai:latest

# Run with GPU support
docker run --gpus all \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    -p 8000:8000 \
    --ipc=host \
    vllm/vllm-openai:latest \
    --model mistralai/Mistral-Small-Instruct-2409 \
    --served-model-name mistral-small \
    --enable-auto-tool-choice
```

#### Python Installation

```bash
# Install vLLM
pip install vllm

# Start server with tool calling support
python -m vllm.entrypoints.openai.api_server \
    --model mistralai/Mistral-Small-Instruct-2409 \
    --host 0.0.0.0 \
    --port 8000 \
    --enable-auto-tool-choice
```

### Advanced vLLM Configuration

#### Performance Optimization

```bash
# GPU memory fraction
--gpu-memory-utilization 0.9

# Tensor parallelism for multi-GPU
--tensor-parallel-size 2

# Quantization
--quantization awq

# Custom context length
--max-model-len 32768

# Batch processing
--max-num-seqs 32

# REQUIRED: Enable tool calling support
--enable-auto-tool-choice
```

#### Multiple Model Serving

```bash
# Start server with multiple models and tool calling
python -m vllm.entrypoints.openai.api_server \
    --model mistralai/Mistral-Small-Instruct-2409 \
    --model microsoft/Phi-3-medium-4k-instruct \
    --served-model-name mistral-small,phi-3-medium \
    --host 0.0.0.0 \
    --port 8000 \
    --enable-auto-tool-choice
```

### iHub Apps Configuration

Create model configuration `contents/models/vllm-local.json`:

```json
{
  "id": "vllm-mistral-small",
  "modelId": "mistral-small",
  "name": {
    "en": "Mistral Small 3.2 (vLLM)",
    "de": "Mistral Small 3.2 (vLLM)"
  },
  "description": {
    "en": "High-performance Mistral Small with tool calling via vLLM",
    "de": "Hochleistungs Mistral Small mit Tool-Calling über vLLM"
  },
  "url": "http://localhost:8000/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 32768,
  "supportsTools": true,
  "supportsImages": false,
  "enabled": true,
  "default": false
}
```

### Environment Configuration

```bash
# API key (can be any value for local vLLM)
export OPENAI_API_KEY="vllm-local"

# Custom endpoint if needed
export VLLM_ENDPOINT="http://localhost:8000"
```

---

## Troubleshooting

### Common Connection Issues

#### LM Studio
```bash
# Check if server is running
curl -X GET http://localhost:1234/v1/models

# Test chat completion
curl -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-oss","messages":[{"role":"user","content":"Hello"}]}'
```

#### Jan.ai
```bash
# Verify server status
curl -X GET http://localhost:1337/v1/models \
  -H "Authorization: Bearer jan-local-key-123"

# Test with authentication
curl -X POST http://localhost:1337/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jan-local-key-123" \
  -d '{"model":"mistralai/Mistral-Small-Instruct-2409","messages":[{"role":"user","content":"Test"}]}'
```

#### vLLM
```bash
# Check vLLM server health
curl http://localhost:8000/health

# List available models
curl http://localhost:8000/v1/models

# Test inference
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral-small","messages":[{"role":"user","content":"Hello"}]}'
```

### Performance Issues

1. **Memory Issues**
   - Reduce model size or use quantized versions
   - Adjust GPU memory allocation
   - Monitor system resources

2. **Slow Response Times**
   - Use smaller models for faster responses
   - Enable GPU acceleration
   - Optimize batch sizes

3. **Connection Timeouts**
   - Increase timeout values in iHub Apps configuration
   - Check firewall and antivirus settings
   - Verify network connectivity

### Model Loading Issues

1. **Model Not Found**
   - Verify model is downloaded and available
   - Check model name matches configuration
   - Ensure sufficient disk space

2. **Incompatible Models**
   - Use GGUF format for LM Studio and Jan.ai
   - Verify model architecture compatibility
   - Check hardware requirements

### iHub Apps Integration Issues

1. **Authentication Errors**
   - Verify API key configuration
   - Check endpoint URLs
   - Ensure CORS is enabled (Jan.ai)

2. **Feature Limitations**
   - Tool calling: Verify model supports function calling
   - Images: Check vision model capabilities
   - Structured output: Confirm provider support

---

## Production Deployment

### Docker Compose Example

```yaml
version: '3.8'
services:
  ihub-apps:
    build: .
    environment:
      - OPENAI_API_KEY=local-key
    ports:
      - "3000:3000"
    depends_on:
      - vllm-server

  vllm-server:
    image: vllm/vllm-openai:latest
    command: >
      --model mistralai/Mistral-Small-Instruct-2409
      --served-model-name mistral-small
      --host 0.0.0.0
      --port 8000
      --gpu-memory-utilization 0.8
      --enable-auto-tool-choice
    ports:
      - "8000:8000"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### Load Balancing Multiple Providers

```json
// contents/models/load-balanced-local.json
{
  "id": "local-cluster",
  "modelId": "distributed-model",
  "name": { "en": "Load Balanced Local Models" },
  "description": { "en": "Multiple local providers for high availability" },
  "url": "http://localhost:8080/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 8192,
  "supportsTools": true,
  "enabled": true
}
```

### Monitoring and Logging

```bash
# Monitor vLLM performance
curl http://localhost:8000/metrics

# Check LM Studio logs
tail -f ~/.config/LMStudio/logs/server.log

# Jan.ai debugging
# Enable debug mode in Jan.ai settings
```

---

## Per-Model API Key Configuration

In some scenarios, you may need different API keys for different models, especially when using multiple providers or when models require specific authentication tokens.

### Method 1: Using apiKey Field in Model Configuration

Instead of using provider-level environment variables, you can specify API keys directly in model configurations:

```json
// contents/models/lm-studio-premium.json
{
  "id": "lm-studio-premium",
  "modelId": "gpt-oss",
  "name": { "en": "GPT-OSS Premium (LM Studio)" },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "apiKey": "lm-studio-premium-key",
  "tokenLimit": 8192,
  "supportsTools": true,
  "enabled": true
}

// contents/models/jan-ai-enterprise.json
{
  "id": "jan-ai-enterprise", 
  "modelId": "mistralai/Mistral-Small-Instruct-2409",
  "name": { "en": "Mistral Small Enterprise (Jan.ai)" },
  "url": "http://localhost:1337/v1/chat/completions",
  "provider": "openai",
  "apiKey": "jan-enterprise-auth-token",
  "tokenLimit": 32768,
  "supportsTools": true,
  "enabled": true
}

// contents/models/vllm-production.json
{
  "id": "vllm-production",
  "modelId": "mistral-small",
  "name": { "en": "Mistral Small Production (vLLM)" },
  "url": "http://production-server:8000/v1/chat/completions", 
  "provider": "openai",
  "apiKey": "production-vllm-secure-key",
  "tokenLimit": 32768,
  "supportsTools": true,
  "enabled": true
}
```

### Method 2: Environment Variable Override per Model

You can use model-specific environment variables that override the default provider key:

```bash
# Default provider key (fallback)
export OPENAI_API_KEY="default-local-key"

# Model-specific keys
export LM_STUDIO_GPT_OSS_KEY="lm-studio-premium-key"
export JAN_MISTRAL_KEY="jan-enterprise-auth-token"
export VLLM_PRODUCTION_KEY="production-vllm-secure-key"
```

Then reference these in your model configurations:

```json
{
  "id": "lm-studio-gpt-oss",
  "modelId": "gpt-oss",
  "name": { "en": "GPT-OSS (LM Studio)" },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "apiKey": "${LM_STUDIO_GPT_OSS_KEY}",
  "tokenLimit": 8192,
  "supportsTools": true,
  "enabled": true
}
```

### Method 3: Multiple Provider Instances

For completely separate provider instances with different authentication:

```json
// contents/models/local-dev-model.json
{
  "id": "local-dev-model",
  "modelId": "gpt-oss", 
  "name": { "en": "Development Model" },
  "url": "http://localhost:1234/v1/chat/completions",
  "provider": "openai",
  "apiKey": "dev-environment-key",
  "tokenLimit": 4096,
  "supportsTools": true,
  "enabled": true
}

// contents/models/local-staging-model.json  
{
  "id": "local-staging-model",
  "modelId": "mistralai/Mistral-Small-Instruct-2409",
  "name": { "en": "Staging Model" },
  "url": "http://staging-host:1337/v1/chat/completions", 
  "provider": "openai",
  "apiKey": "staging-environment-key",
  "tokenLimit": 8192,
  "supportsTools": true,
  "enabled": true
}

// contents/models/local-prod-model.json
{
  "id": "local-prod-model", 
  "modelId": "mistral-small",
  "name": { "en": "Production Model" },
  "url": "http://prod-cluster:8000/v1/chat/completions",
  "provider": "openai", 
  "apiKey": "production-secure-token",
  "tokenLimit": 32768,
  "supportsTools": true,
  "enabled": true
}
```

### Security Best Practices for Per-Model Keys

1. **Environment Variables**: Store sensitive keys in environment variables, not directly in JSON files
2. **Key Rotation**: Implement regular key rotation for production environments
3. **Access Control**: Use different keys for different environments (dev/staging/prod)
4. **Monitoring**: Log authentication failures and monitor for unauthorized access
5. **Least Privilege**: Grant minimal required permissions for each API key

### Example Environment File (.env)

```bash
# Default fallback
OPENAI_API_KEY="default-local-key"

# LM Studio instances
LM_STUDIO_DEV_KEY="lms-dev-12345"
LM_STUDIO_PROD_KEY="lms-prod-67890"

# Jan.ai instances  
JAN_DEV_KEY="jan-dev-abcdef"
JAN_PROD_KEY="jan-prod-ghijkl"

# vLLM clusters
VLLM_DEV_KEY="vllm-dev-mnopqr"
VLLM_STAGING_KEY="vllm-staging-stuvwx"
VLLM_PROD_KEY="vllm-prod-yzabcd"
```

This approach provides fine-grained control over authentication while maintaining security and flexibility across different deployment scenarios.

---

## Best Practices

### Security

1. **Local Network Only**: Use `127.0.0.1` for single-machine setups
2. **API Keys**: Use strong, unique API keys for each deployment
3. **Firewall Rules**: Restrict access to trusted IP ranges
4. **Regular Updates**: Keep all providers updated to latest versions

### Performance

1. **Hardware Optimization**: Match model size to available hardware
2. **Model Selection**: Choose appropriate models for your use cases
3. **Caching**: Implement response caching for repeated queries
4. **Load Testing**: Test under expected concurrent user loads

### Monitoring

1. **Resource Usage**: Monitor CPU, GPU, and memory consumption
2. **Response Times**: Track inference latency and throughput
3. **Error Rates**: Monitor for failed requests and connection issues
4. **Model Performance**: Evaluate output quality regularly

### Maintenance

1. **Model Updates**: Regularly update to newer model versions
2. **Configuration Backups**: Backup model and app configurations
3. **Log Rotation**: Manage log file sizes and retention
4. **Health Checks**: Implement automated health monitoring

---

This comprehensive guide enables you to leverage the full power of local LLM providers with iHub Apps, ensuring privacy, performance, and flexibility for your AI applications.