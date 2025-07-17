# API Documentation & Message Analysis Summary

This document summarizes the comprehensive testing and documentation system we've built to analyze LLM API interactions, tool calling behavior, and message format differences across providers.

## 🎯 What We've Accomplished

### 1. **Comprehensive API Documentation Test** (`comprehensive-api-documentation.test.js`)

- **Purpose**: Documents ALL messages, requests, and responses for each provider
- **Features**:
  - Complete request/response logging with JSON files
  - Multi-turn conversation testing with tool calls
  - Simulated tool responses and follow-up conversations
  - Automatic comparison report generation
  - API format difference analysis

### 2. **Tool Call Verification Test** (`tool-call-verification.test.js`)

- **Purpose**: Verifies that LLMs actually want to call tools when appropriate
- **Features**:
  - Tests different prompt scenarios (direct, indirect, no tool needed)
  - Documents exact request/response formats
  - Analyzes tool call accuracy across providers
  - Shows detailed JSON for every interaction

### 3. **Azure OpenAI Configuration Support** (`azure-openai-test.js`)

- **Purpose**: Specifically tests Azure OpenAI configurations
- **Features**:
  - Proper `api-key` header authentication
  - Configurable base URLs and model IDs
  - Non-streaming response testing

## 🔍 Key Findings from Your Test Run

### Provider Behavior Analysis

#### **OpenAI (Azure)**

- ❌ **Status**: Network connection issues (likely network/firewall related)
- **Request Format**: Standard OpenAI format with Azure-specific URL
- **Authentication**: `api-key` header (not Bearer token)
- **Tools**: Uses `function` wrapper with `type` field

#### **Anthropic** ✅

- **Status**: Working perfectly
- **Tool Call Accuracy**: 2/3 (67%) - Made tool calls when expected, but also called weather tool for "What is the capital of France?"
- **Request Format**:
  ```json
  {
    "tools": [
      {
        "name": "get_weather",
        "description": "...",
        "input_schema": { ... }
      }
    ]
  }
  ```
- **Response Format**:
  ```json
  {
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "...", "name": "get_weather", "input": {...} }
    ]
  }
  ```

#### **Google Gemini** ✅

- **Status**: Working perfectly
- **Tool Call Accuracy**: 2/3 (67%) - Similar behavior to Anthropic
- **Request Format**:
  ```json
  {
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "get_weather",
            "description": "...",
            "parameters": { ... }
          }
        ]
      }
    ]
  }
  ```
- **Response Format**:
  ```json
  {
    "candidates": [
      {
        "content": {
          "parts": [
            { "functionCall": { "name": "get_weather", "args": {...} } }
          ]
        }
      }
    ]
  }
  ```

#### **Mistral** ✅

- **Status**: Working well
- **Tool Call Accuracy**: 3/3 (100%) - Best accuracy!
- **Request Format**: Same as OpenAI (OpenAI-compatible)
- **Response Format**: Same as OpenAI

## 📊 API Format Differences Documented

### Request Formats

| Provider  | Tool Definition                       | Authentication                       | Message Structure |
| --------- | ------------------------------------- | ------------------------------------ | ----------------- |
| OpenAI    | `{type: "function", function: {...}}` | `Authorization: Bearer` or `api-key` | `messages: [...]` |
| Anthropic | `{name: "...", input_schema: {...}}`  | `x-api-key`                          | `messages: [...]` |
| Google    | `{functionDeclarations: [...]}`       | `?key=` in URL                       | `contents: [...]` |
| Mistral   | Same as OpenAI                        | `Authorization: Bearer`              | `messages: [...]` |

### Response Formats

| Provider  | Tool Call Location                           | ID Generation      | Arguments Format |
| --------- | -------------------------------------------- | ------------------ | ---------------- |
| OpenAI    | `choices[0].message.tool_calls`              | Auto-generated     | JSON string      |
| Anthropic | `content[].type === "tool_use"`              | Auto-generated     | Object           |
| Google    | `candidates[0].content.parts[].functionCall` | Manual (timestamp) | Object           |
| Mistral   | Same as OpenAI                               | Auto-generated     | JSON string      |

## 🚀 Available Test Scripts

```bash
# Basic adapter tests
npm run test:openai
npm run test:anthropic
npm run test:google
npm run test:mistral
npm run test:all

# Advanced tool calling tests
npm run test:tool-calling           # Format consistency
npm run test:tool-integration       # High-level integration
npm run test:real-llm              # Real API calls
npm run test:azure-openai          # Azure OpenAI specific
npm run test:tool-verification     # Tool call accuracy
npm run test:api-documentation     # Comprehensive logging
```

## 📝 Multi-Turn Conversation Testing

The comprehensive documentation test includes:

1. **Initial user message** with tool call request
2. **Assistant response** with tool calls
3. **Simulated tool responses**
4. **Follow-up user question**
5. **Final assistant response**

This tests the complete conversation flow and ensures message formats work correctly across multiple turns.

## 🛠️ Configuration Options

### Environment Variables

```bash
# API Keys
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
export GOOGLE_API_KEY="your-key"
export MISTRAL_API_KEY="your-key"

# Base URLs (for Azure OpenAI, self-hosted, etc.)
export OPENAI_BASE_URL="https://your-azure-instance.openai.azure.com/..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com/v1/messages"
export GOOGLE_BASE_URL="https://generativelanguage.googleapis.com/..."
export MISTRAL_BASE_URL="https://api.mistral.ai/v1/chat/completions"

# Model IDs
export OPENAI_MODEL_ID="gpt-4o-mini"
export ANTHROPIC_MODEL_ID="claude-3-haiku-20240307"
export GOOGLE_MODEL_ID="gemini-1.5-flash"
export MISTRAL_MODEL_ID="mistral-small-latest"
```

## 📊 Test Results Summary

From your test run:

- **Total providers tested**: 4
- **Successful API calls**: 9/12 (75%)
- **Providers with tool calls**: 3/4 (OpenAI had network issues)
- **Tool call accuracy**: Mistral (100%) > Anthropic & Google (67%)

## 🎉 Key Benefits

1. **Complete Transparency**: See exactly what's sent and received
2. **Multi-Provider Support**: Works with OpenAI, Azure OpenAI, Anthropic, Google, Mistral
3. **Tool Call Verification**: Confirms LLMs actually want to use tools
4. **Format Documentation**: Clear differences between provider APIs
5. **Multi-Turn Testing**: Ensures conversation flows work correctly
6. **Automated Reporting**: JSON logs and comparison reports

The system now gives you complete visibility into how each provider handles tool calling, message formatting, and multi-turn conversations!
