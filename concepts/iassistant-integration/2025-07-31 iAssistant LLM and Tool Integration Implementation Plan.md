# iAssistant LLM and Tool Integration Implementation Plan

**Date:** 2025-07-31  
**Type:** Technical Implementation Plan  
**Authors:** Claude Code  
**Status:** Draft

## Executive Summary

This document provides a comprehensive implementation plan for integrating iFinder's iAssistant as both an LLM adapter and a tool within the AI Hub Apps architecture. The integration leverages existing iFinder service infrastructure while addressing the unique characteristics of iAssistant (non-conversational, single-turn requests).

## Business Value and Objectives

### Primary Objectives

1. **Dual Integration**: Expose iAssistant as both an LLM model option AND as a tool for other LLMs to use
2. **Enterprise Knowledge Access**: Enable direct access to corporate knowledge through iAssistant's RAG capabilities
3. **Seamless User Experience**: Maintain consistent UI/UX patterns while accommodating iAssistant's unique characteristics
4. **Authentication Integration**: Ensure all requests are made in the authenticated user's context

### Business Value

- **Knowledge Democratization**: Users can access corporate knowledge directly through natural language
- **Reduced Knowledge Silos**: Break down barriers between different information systems
- **Enhanced Decision Making**: Provide contextual, enterprise-specific responses
- **Compliance and Security**: Maintain user-based access controls and audit trails

## Current Architecture Analysis

### Existing LLM Adapter Pattern

The AI Hub Apps uses a standardized adapter pattern for LLM integration:

**Base Structure:**

- `BaseAdapter.js`: Common functionality and utilities
- Provider-specific adapters: `openai.js`, `anthropic.js`, `google.js`, `mistral.js`, `vllm.js`
- Centralized registration in `adapters/index.js`
- Model configurations in `contents/models/*.json`

**Key Adapter Methods:**

```javascript
class ProviderAdapter extends BaseAdapter {
  formatMessages(messages)           // Format messages for provider API
  createCompletionRequest(model, messages, apiKey, options)  // Build request
  processResponseBuffer(buffer)      // Process streaming response
}
```

### Existing iFinder Integration

**Current Components:**

- `iFinderService.js`: Comprehensive service with search, content, metadata operations
- `iFinderJwt.js`: JWT token generation for user authentication
- `iFinder.js`: Tool wrapper with search, getContent, getMetadata functions
- Tool configuration in `tools.json` with multi-function support

**Key Capabilities:**

- User-context authentication via JWT
- Document search, content retrieval, metadata fetching
- Proper error handling and request throttling
- Action tracking and audit logging

### RAG API Sample Analysis

The `rag-api-sample.txt` shows an advanced RAG implementation with:

- Client registration and SSE streaming
- Question/answer processing with telemetry
- Related questions generation
- Document passages retrieval
- Feedback collection

## iAssistant Characteristics and Constraints

### Key Characteristics

1. **Non-conversational**: Each request is independent, no multi-turn conversation support
2. **RAG-enabled**: Returns responses based on indexed document corpus
3. **User-context**: All requests must be made on behalf of authenticated user
4. **Single endpoint**: One API endpoint handles question processing
5. **Streaming capable**: Can provide real-time response streaming

### Technical Constraints

1. **No conversation history**: Cannot maintain context between requests
2. **Authentication required**: Anonymous access not supported
3. **Limited customization**: System prompts become context/guidance
4. **Fixed response format**: Cannot customize output schemas like other LLMs

## Implementation Plan

### Phase 1: iAssistant LLM Adapter Implementation

#### 1.1 Create iAssistant Adapter

**File:** `server/adapters/iassistant.js`

```javascript
import { BaseAdapter } from './BaseAdapter.js';
import iFinderService from '../services/integrations/iFinderService.js';

class IAssistantAdapterClass extends BaseAdapter {
  /**
   * Format messages for iAssistant - combine into single question
   * iAssistant doesn't support conversation history, so we need to
   * create context from the conversation and system prompt
   */
  formatMessages(messages) {
    // Extract system prompt and conversation context
    const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';

    // Combine system prompt as context with the latest user question
    let contextualQuestion = lastUserMessage;
    if (systemPrompt) {
      contextualQuestion = `Context: ${systemPrompt}\n\nQuestion: ${lastUserMessage}`;
    }

    return contextualQuestion;
  }

  /**
   * Create completion request for iAssistant
   * Uses the iFinder service with special iAssistant endpoints
   */
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature = 0.7, stream = true, user, chatId } = options;

    if (!user || user.id === 'anonymous') {
      throw new Error('iAssistant requires authenticated user');
    }

    const question = this.formatMessages(messages);

    // Return a special request object that will be handled differently
    return {
      type: 'iassistant',
      question,
      model,
      user,
      chatId,
      stream,
      temperature,
      // Additional iAssistant-specific options
      searchProfile: model.searchProfile || 'default',
      maxResults: model.maxResults || 10
    };
  }

  /**
   * Process response - this will be called with streaming chunks from iAssistant
   */
  processResponseBuffer(data) {
    // iAssistant responses come in RAG API format
    // Convert to standardized format expected by AI Hub Apps
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;
    if (data === '[DONE]') {
      result.complete = true;
      return result;
    }

    try {
      // Handle different event types from iAssistant streaming
      if (typeof data === 'object' && data.event) {
        switch (data.event) {
          case 'answer':
            const answerData = JSON.parse(data.data);
            result.content.push(answerData.answer || '');
            break;
          case 'complete':
            result.complete = true;
            result.finishReason = 'stop';
            break;
          case 'error':
            result.error = true;
            result.errorMessage = data.data;
            break;
        }
      } else if (typeof data === 'string') {
        // Handle direct text response
        result.content.push(data);
      }
    } catch (error) {
      console.error('Error parsing iAssistant response:', error);
      result.error = true;
      result.errorMessage = `Error parsing response: ${error.message}`;
    }

    return result;
  }
}

const IAssistantAdapter = new IAssistantAdapterClass();
export default IAssistantAdapter;
```

#### 1.2 Register Adapter

**File:** `server/adapters/index.js`

```javascript
// Add import
import IAssistantAdapter from './iassistant.js';

// Update adapters registry
const adapters = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  google: GoogleAdapter,
  mistral: MistralAdapter,
  local: VLLMAdapter,
  iassistant: IAssistantAdapter // Add iAssistant adapter
};
```

#### 1.3 Create iAssistant Model Configuration

**File:** `contents/models/iassistant-rag.json`

```json
{
  "id": "iassistant-rag",
  "modelId": "iassistant-rag",
  "name": {
    "en": "iAssistant RAG",
    "de": "iAssistant RAG"
  },
  "description": {
    "en": "Enterprise knowledge assistant with access to corporate documents and data",
    "de": "Unternehmens-Wissensassistent mit Zugang zu Unternehmensdokumenten und -daten"
  },
  "url": "/api/iassistant/ask",
  "provider": "iassistant",
  "tokenLimit": 4096,
  "supportsTools": false,
  "supportsImages": false,
  "supportsStreaming": true,
  "enabled": true,
  "default": false,
  "searchProfile": "searchprofile-standard",
  "features": {
    "followup-questions": true
  }
}
```

### Phase 2: Custom Request Handling

#### 2.1 Create iAssistant Request Handler

**File:** `server/services/chat/IAssistantHandler.js`

```javascript
import iFinderService from '../integrations/iFinderService.js';
import { createRAGApi } from '../../temp/rag-api.js';

export class IAssistantHandler {
  constructor() {
    this.activeClients = new Map();
  }

  /**
   * Handle iAssistant completion request
   * This integrates with the existing iFinder service but adapts for LLM usage
   */
  async handleCompletionRequest(request, res) {
    const { question, user, chatId, stream, model } = request;

    try {
      if (stream) {
        // Set up SSE streaming for iAssistant responses
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Create unique client ID for this request
        const clientId = `iassistant-${Date.now()}-${Math.random()}`;

        // Initialize RAG client (reusing existing RAG infrastructure)
        const ragApi = createRAGApi(
          'http',
          process.env.IASSISTANT_BASE_URL || 'http://localhost:8080'
        );
        const eventSource = await ragApi.registerClient(clientId);

        // Set up event forwarding
        this.setupEventForwarding(eventSource, res, clientId);

        // Send the question to iAssistant
        await ragApi.askQuestion(clientId, question, {
          profileId: model.searchProfile,
          searchMode: 'multiword'
        });

        // Handle cleanup on client disconnect
        req.on('close', async () => {
          await ragApi.stopClient(clientId);
        });
      } else {
        // Non-streaming request - collect full response
        const response = await this.getNonStreamingResponse(question, user, chatId, model);
        res.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: response.content
              },
              finish_reason: 'stop'
            }
          ]
        });
      }
    } catch (error) {
      console.error('iAssistant request error:', error);
      if (stream) {
        this.sendSSE(res, 'error', { error: error.message });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  }

  /**
   * Set up event forwarding from iAssistant to client
   */
  setupEventForwarding(eventSource, res, clientId) {
    eventSource.addEventListener('answer', event => {
      const data = `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: JSON.parse(event.data).answer
            }
          }
        ]
      })}\n\n`;
      res.write(data);
    });

    eventSource.addEventListener('complete', () => {
      const data = `data: ${JSON.stringify({
        choices: [
          {
            delta: {},
            finish_reason: 'stop'
          }
        ]
      })}\n\n`;
      res.write(data);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    eventSource.addEventListener('error', event => {
      const data = `data: ${JSON.stringify({
        error: { message: event.data }
      })}\n\n`;
      res.write(data);
      res.end();
    });
  }

  /**
   * Get non-streaming response from iAssistant
   */
  async getNonStreamingResponse(question, user, chatId, model) {
    // Use existing iFinder service for document search
    const searchResults = await iFinderService.search({
      query: question,
      user,
      chatId,
      maxResults: model.maxResults || 10,
      searchProfile: model.searchProfile
    });

    // Format results for context
    const context = searchResults.results
      .slice(0, 5)
      .map(doc => `${doc.title}: ${doc.description_texts?.join(' ') || ''}`)
      .join('\n\n');

    // For non-streaming, we could call a separate iAssistant endpoint
    // or simulate a response based on search results
    return {
      content: `Based on the available documents:\n\n${context}\n\nAnswer: This is a simulated iAssistant response for non-streaming mode.`,
      metadata: {
        documentsFound: searchResults.totalFound,
        searchProfile: model.searchProfile
      }
    };
  }

  /**
   * Send SSE event
   */
  sendSSE(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }
}

export default new IAssistantHandler();
```

#### 2.2 Integrate Handler into Chat Service

**File:** `server/services/chat/ChatService.js` (modify existing)

```javascript
// Add import
import iAssistantHandler from './IAssistantHandler.js';

// In the ChatService class, modify the createCompletion method:
async createCompletion(model, messages, options = {}) {
  // ... existing code ...

  // Check for iAssistant requests
  if (request.type === 'iassistant') {
    return await iAssistantHandler.handleCompletionRequest(request, this.res);
  }

  // ... rest of existing code ...
}
```

### Phase 3: iAssistant Tool Implementation

#### 3.1 Create iAssistant Tool

**File:** `server/tools/iAssistant.js`

```javascript
import iFinderService from '../services/integrations/iFinderService.js';
import { createRAGApi } from '../temp/rag-api.js';

/**
 * iAssistant Tool for AI Hub Apps
 * Allows other LLMs to ask questions to iAssistant and get enterprise knowledge responses
 */

/**
 * Ask a question to iAssistant and get a knowledge-based response
 * @param {Object} params - Tool parameters
 * @returns {Object} iAssistant response with enterprise knowledge
 */
export async function askQuestion({
  question,
  searchProfile = 'default',
  maxResults = 10,
  includePassages = true,
  user,
  chatId
}) {
  if (!question) {
    throw new Error('Question parameter is required');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iAssistant tool requires authenticated user');
  }

  if (!chatId) {
    throw new Error('Chat ID is required for tracking');
  }

  console.log(`iAssistant Tool: User ${user.email || user.id} asking: "${question}"`);

  try {
    // Create RAG client for iAssistant communication
    const clientId = `tool-${Date.now()}-${Math.random()}`;
    const ragApi = createRAGApi('http', process.env.IASSISTANT_BASE_URL || 'http://localhost:8080');

    // For tool usage, we need to collect the full response
    const response = await new Promise((resolve, reject) => {
      let fullResponse = '';
      let passages = [];
      let telemetry = {};
      let relatedQuestions = [];

      ragApi
        .registerClient(clientId)
        .then(eventSource => {
          const timeout = setTimeout(() => {
            eventSource.close();
            reject(new Error('iAssistant request timeout'));
          }, 30000);

          eventSource.addEventListener('answer', event => {
            const data = JSON.parse(event.data);
            fullResponse += data.answer || '';
          });

          eventSource.addEventListener('passages', event => {
            if (includePassages) {
              const data = JSON.parse(event.data);
              passages = data.passages || [];
            }
          });

          eventSource.addEventListener('telemetry', event => {
            const data = JSON.parse(event.data);
            telemetry = { ...telemetry, ...data };
          });

          eventSource.addEventListener('related', event => {
            const data = JSON.parse(event.data);
            relatedQuestions = data.questions?.related_questions || [];
          });

          eventSource.addEventListener('complete', () => {
            clearTimeout(timeout);
            eventSource.close();
            resolve({
              answer: fullResponse.trim(),
              passages,
              telemetry,
              relatedQuestions
            });
          });

          eventSource.addEventListener('error', event => {
            clearTimeout(timeout);
            eventSource.close();
            reject(new Error(`iAssistant error: ${event.data}`));
          });

          // Send the question
          ragApi
            .askQuestion(clientId, question, {
              profileId: searchProfile,
              searchMode: 'multiword',
              metaData: true,
              telemetry: true
            })
            .catch(reject);
        })
        .catch(reject);
    });

    const result = {
      question,
      answer: response.answer,
      searchProfile,
      metadata: {
        totalDocuments: response.telemetry?.retrieval_number_of_candidate_documents || 0,
        relevantPassages: response.telemetry?.retrieval_final_number_of_retrieved_passages || 0,
        processingTime: response.telemetry?.overall_duration || 0,
        model: response.telemetry?.model || 'unknown'
      }
    };

    // Include passages if requested
    if (includePassages && response.passages?.length > 0) {
      result.passages = response.passages.map(passage => ({
        text: Array.isArray(passage.text) ? passage.text.join(' ') : passage.text,
        score: passage.score,
        documentId: passage.id,
        metadata: passage.metadata
      }));
    }

    // Include related questions
    if (response.relatedQuestions?.length > 0) {
      result.relatedQuestions = response.relatedQuestions;
    }

    console.log(
      `iAssistant Tool: Generated response with ${result.metadata.relevantPassages} passages in ${result.metadata.processingTime}s`
    );
    return result;
  } catch (error) {
    console.error('iAssistant tool error:', error);
    throw new Error(`iAssistant question failed: ${error.message}`);
  }
}

/**
 * Get document content through iAssistant's document retrieval
 * This is a convenience method that combines search and content retrieval
 */
export async function getDocumentContext({
  query,
  documentIds = [],
  searchProfile = 'default',
  maxResults = 5,
  user,
  chatId
}) {
  if (!query && documentIds.length === 0) {
    throw new Error('Either query or documentIds must be provided');
  }

  if (!user || user.id === 'anonymous') {
    throw new Error('iAssistant tool requires authenticated user');
  }

  try {
    let documents = [];

    if (query) {
      // Search for documents
      const searchResults = await iFinderService.search({
        query,
        user,
        chatId,
        maxResults,
        searchProfile,
        returnFields: ['id', 'title', 'description_texts', 'summary_texts', 'url']
      });
      documents = searchResults.results;
    }

    // If specific document IDs provided, fetch those
    if (documentIds.length > 0) {
      for (const docId of documentIds) {
        try {
          const content = await iFinderService.getContent({
            documentId: docId,
            user,
            chatId,
            searchProfile,
            maxLength: 5000
          });
          documents.push({
            id: docId,
            title: content.metadata.title,
            content: content.content,
            url: content.metadata.url
          });
        } catch (error) {
          console.warn(`Failed to fetch content for document ${docId}:`, error.message);
        }
      }
    }

    return {
      query,
      searchProfile,
      totalDocuments: documents.length,
      documents: documents.map(doc => ({
        id: doc.id,
        title: doc.title,
        summary: doc.description_texts?.join(' ') || doc.summary_texts?.join(' ') || '',
        content: doc.content || '',
        url: doc.url
      }))
    };
  } catch (error) {
    console.error('iAssistant document context error:', error);
    throw new Error(`Failed to get document context: ${error.message}`);
  }
}

// Export default with all methods
export default {
  askQuestion,
  getDocumentContext
};
```

#### 3.2 Update Tool Configuration

**File:** `contents/config/tools.json` (add to existing array)

```json
{
  "id": "iAssistant",
  "name": "iAssistant",
  "title": {
    "en": "iAssistant Enterprise Knowledge",
    "de": "iAssistant Unternehmenswissen"
  },
  "description": {
    "en": "Ask questions to iAssistant and get responses based on enterprise knowledge and documents. Perfect for accessing corporate information, policies, and procedures.",
    "de": "Stellen Sie Fragen an iAssistant und erhalten Sie Antworten basierend auf Unternehmenswissen und Dokumenten. Perfekt für den Zugriff auf Unternehmensinformationen, Richtlinien und Verfahren."
  },
  "script": "iAssistant.js",
  "concurrency": 3,
  "functions": {
    "askQuestion": {
      "description": {
        "en": "Ask a question to iAssistant and get a knowledge-based response from enterprise documents",
        "de": "Stellen Sie eine Frage an iAssistant und erhalten Sie eine wissensbasierte Antwort aus Unternehmensdokumenten"
      },
      "parameters": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string",
            "description": {
              "en": "The question to ask iAssistant. Should be clear and specific. Example: 'What are the company's remote work policies?' or 'How do I submit an expense report?'",
              "de": "Die Frage an iAssistant. Sollte klar und spezifisch sein. Beispiel: 'Was sind die Homeoffice-Richtlinien des Unternehmens?' oder 'Wie reiche ich eine Spesenabrechnung ein?'"
            }
          },
          "searchProfile": {
            "type": "string",
            "description": {
              "en": "Search profile to use for document retrieval (optional, uses default if not specified)",
              "de": "Suchprofil für den Dokumentenabruf (optional, verwendet Standard wenn nicht angegeben)"
            },
            "default": "default"
          },
          "maxResults": {
            "type": "integer",
            "description": {
              "en": "Maximum number of documents to consider for the response (default: 10)",
              "de": "Maximale Anzahl der Dokumente für die Antwort (Standard: 10)"
            },
            "default": 10,
            "minimum": 3,
            "maximum": 25
          },
          "includePassages": {
            "type": "boolean",
            "description": {
              "en": "Whether to include document passages in the response for reference (default: true)",
              "de": "Ob Dokumentpassagen in der Antwort als Referenz enthalten sein sollen (Standard: true)"
            },
            "default": true
          }
        },
        "required": ["question"]
      }
    },
    "getDocumentContext": {
      "description": {
        "en": "Retrieve document context for a query or specific document IDs through iAssistant",
        "de": "Dokumentkontext für eine Abfrage oder spezifische Dokument-IDs über iAssistant abrufen"
      },
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": {
              "en": "Search query to find relevant documents (optional if documentIds provided)",
              "de": "Suchanfrage zum Finden relevanter Dokumente (optional wenn documentIds angegeben)"
            }
          },
          "documentIds": {
            "type": "array",
            "items": { "type": "string" },
            "description": {
              "en": "Specific document IDs to retrieve (optional if query provided)",
              "de": "Spezifische Dokument-IDs zum Abrufen (optional wenn query angegeben)"
            }
          },
          "searchProfile": {
            "type": "string",
            "description": {
              "en": "Search profile for document access",
              "de": "Suchprofil für Dokumentzugriff"
            },
            "default": "default"
          },
          "maxResults": {
            "type": "integer",
            "description": {
              "en": "Maximum number of documents to retrieve",
              "de": "Maximale Anzahl der abzurufenden Dokumente"
            },
            "default": 5,
            "minimum": 1,
            "maximum": 15
          }
        }
      }
    }
  }
}
```

### Phase 4: Configuration and Integration

#### 4.1 Update Platform Configuration

**File:** `contents/config/platform.json` (add to existing configuration)

```json
{
  "iFinder": {
    "baseUrl": "https://your-ifinder-api.com",
    "endpoints": {
      "search": "/public-api/retrieval/api/v1/search-profiles/{profileId}/_search",
      "document": "/public-api/retrieval/api/v1/search-profiles/{profileId}/docs/{docId}",
      "iAssistant": "/api/v2/rag"
    },
    "defaultSearchProfile": "default",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "algorithm": "RS256",
    "issuer": "ai-hub-apps",
    "audience": "ifinder-api",
    "tokenExpirationSeconds": 3600,
    "defaultScope": "fa_index_read"
  }
}
```

#### 4.2 Environment Variables

Add to your environment configuration:

```bash
# iAssistant Integration
IASSISTANT_BASE_URL=https://your-iassistant-api.com
IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
IFINDER_API_URL=https://your-ifinder-api.com
IFINDER_SEARCH_PROFILE=default
IFINDER_TIMEOUT=30000
```

### Phase 5: Application Configuration

#### 5.1 Create iAssistant-specific Apps

**File:** `contents/apps/iassistant-chat.json`

```json
{
  "id": "iassistant-chat",
  "order": 1,
  "name": {
    "en": "Enterprise Knowledge Chat",
    "de": "Unternehmenswissen Chat"
  },
  "description": {
    "en": "Chat directly with your enterprise knowledge base using iAssistant",
    "de": "Chatten Sie direkt mit Ihrer Unternehmenswissensbasis über iAssistant"
  },
  "color": "#2563eb",
  "icon": "fas fa-building",
  "system": {
    "en": "You are an enterprise knowledge assistant with access to company documents, policies, and procedures. Provide accurate, helpful responses based on the available information. If you don't have specific information, clearly state this and suggest how the user might find what they need.",
    "de": "Sie sind ein Unternehmenswissensassistent mit Zugang zu Firmendokumenten, Richtlinien und Verfahren. Geben Sie genaue, hilfreiche Antworten basierend auf den verfügbaren Informationen. Wenn Sie keine spezifischen Informationen haben, sagen Sie dies klar und schlagen vor, wie der Nutzer finden könnte, was er braucht."
  },
  "tokenLimit": 4096,
  "preferredModel": "iassistant-rag",
  "allowedModels": ["iassistant-rag"],
  "disallowModelSelection": true,
  "sendChatHistory": false,
  "messagePlaceholder": {
    "en": "Ask about company policies, procedures, or any enterprise information...",
    "de": "Fragen Sie nach Unternehmensrichtlinien, Verfahren oder anderen Unternehmensinformationen..."
  },
  "greeting": {
    "en": "👋 Hello! I'm your Enterprise Knowledge Assistant powered by iAssistant. I can help you find information from company documents, policies, procedures, and more. What would you like to know?",
    "de": "👋 Hallo! Ich bin Ihr Unternehmenswissensassistent powered by iAssistant. Ich kann Ihnen helfen, Informationen aus Firmendokumenten, Richtlinien, Verfahren und mehr zu finden. Was möchten Sie wissen?"
  },
  "starterPrompts": [
    {
      "title": {
        "en": "Company Policies",
        "de": "Unternehmensrichtlinien"
      },
      "prompt": {
        "en": "What are the main company policies I should know about?",
        "de": "Was sind die wichtigsten Unternehmensrichtlinien, die ich kennen sollte?"
      }
    },
    {
      "title": {
        "en": "Remote Work",
        "de": "Homeoffice"
      },
      "prompt": {
        "en": "What are the remote work guidelines and policies?",
        "de": "Was sind die Homeoffice-Richtlinien und -Bestimmungen?"
      }
    },
    {
      "title": {
        "en": "IT Support",
        "de": "IT-Support"
      },
      "prompt": {
        "en": "How do I get IT support or report technical issues?",
        "de": "Wie erhalte ich IT-Support oder melde technische Probleme?"
      }
    }
  ],
  "category": "Enterprise",
  "enabled": true
}
```

**File:** `contents/apps/enhanced-research-assistant.json`

```json
{
  "id": "enhanced-research-assistant",
  "order": 10,
  "name": {
    "en": "Enhanced Research Assistant",
    "de": "Erweiterte Recherche-Assistent"
  },
  "description": {
    "en": "Comprehensive research assistant with access to both web search and enterprise knowledge",
    "de": "Umfassender Recherche-Assistent mit Zugang zu Websuche und Unternehmenswissen"
  },
  "color": "#7c3aed",
  "icon": "fas fa-search-plus",
  "system": {
    "en": "You are a comprehensive research assistant with access to both web search tools and enterprise knowledge through iAssistant. For enterprise-related questions, use the iAssistant tool. For general information or current events, use web search tools. Always cite your sources and provide comprehensive, well-researched answers.",
    "de": "Sie sind ein umfassender Recherche-Assistent mit Zugang zu Websuchtools und Unternehmenswissen über iAssistant. Für unternehmensbezogene Fragen verwenden Sie das iAssistant-Tool. Für allgemeine Informationen oder aktuelle Ereignisse verwenden Sie Websuchtools. Zitieren Sie immer Ihre Quellen und geben Sie umfassende, gut recherchierte Antworten."
  },
  "tokenLimit": 8192,
  "preferredModel": "gpt-4",
  "tools": ["iAssistant", "braveSearch", "webContentExtractor", "enhancedWebSearch"],
  "sendChatHistory": true,
  "messagePlaceholder": {
    "en": "Ask me anything - I can search both enterprise knowledge and the web...",
    "de": "Fragen Sie mich alles - ich kann sowohl Unternehmenswissen als auch das Web durchsuchen..."
  },
  "greeting": {
    "en": "🔍 Hello! I'm your Enhanced Research Assistant. I can help you find information from both your enterprise knowledge base and the web. Whether you need company-specific information or general research, I'm here to help. What would you like to research?",
    "de": "🔍 Hallo! Ich bin Ihr erweiterte Recherche-Assistent. Ich kann Ihnen helfen, Informationen sowohl aus Ihrer Unternehmenswissensbasis als auch aus dem Web zu finden. Ob Sie firmenspezifische Informationen oder allgemeine Recherchen benötigen, ich bin hier, um zu helfen. Was möchten Sie recherchieren?"
  },
  "starterPrompts": [
    {
      "title": {
        "en": "Enterprise + Web Research",
        "de": "Unternehmens- + Web-Recherche"
      },
      "prompt": {
        "en": "Compare our company's sustainability policies with industry best practices",
        "de": "Vergleichen Sie die Nachhaltigkeitsrichtlinien unseres Unternehmens mit den besten Praktiken der Branche"
      }
    },
    {
      "title": {
        "en": "Market Analysis",
        "de": "Marktanalyse"
      },
      "prompt": {
        "en": "What are the latest trends in our industry and how do they relate to our current strategy?",
        "de": "Was sind die neuesten Trends in unserer Branche und wie stehen sie zu unserer aktuellen Strategie?"
      }
    }
  ],
  "category": "Research",
  "enabled": true
}
```

## Error Handling and Edge Cases

### Authentication Errors

- **Invalid User**: Clear error message when anonymous users try to access iAssistant
- **JWT Failures**: Proper error handling for token generation/validation failures
- **Permission Denied**: Handle cases where user lacks access to specific search profiles

### API Connectivity Issues

- **Timeout Handling**: Graceful timeout for iAssistant requests (30s default)
- **Connection Failures**: Fallback error messages and retry logic
- **Rate Limiting**: Respect iAssistant API rate limits with proper backoff

### Response Processing

- **Malformed Responses**: Handle unexpected response formats gracefully
- **Empty Results**: Appropriate messaging when no knowledge is found
- **Streaming Interruptions**: Handle SSE connection drops and reconnection

### Configuration Errors

- **Missing Configuration**: Clear setup instructions when iAssistant config is missing
- **Invalid Search Profiles**: Validation and fallback to default profiles
- **Model Registration**: Proper error handling if iAssistant models aren't properly registered

## Security Considerations

### User Authentication

- All iAssistant requests must include valid user authentication
- JWT tokens are generated per-request with proper expiration
- User permissions are enforced at the iAssistant API level

### Data Privacy

- No conversation history is stored for iAssistant interactions
- All requests are made in the authenticated user's context
- Audit logging tracks all iAssistant usage for compliance

### API Security

- Private keys for JWT signing are stored securely
- HTTPS is enforced for all iAssistant communications
- Rate limiting prevents abuse of enterprise knowledge access

## Performance Optimizations

### Caching Strategy

- No response caching due to user-specific and time-sensitive nature of enterprise knowledge
- JWT token caching for duration of chat session
- Connection pooling for iAssistant API requests

### Resource Management

- Concurrent request limiting (3 max concurrent iAssistant requests per user)
- Timeout management to prevent resource leaks
- Proper cleanup of SSE connections and RAG clients

### Monitoring and Metrics

- Track iAssistant usage patterns and response times
- Monitor authentication success/failure rates
- Alert on API connectivity issues or high error rates

## Testing Strategy

### Unit Tests

- Test iAssistant adapter message formatting
- Test JWT token generation and validation
- Test error handling for various failure scenarios

### Integration Tests

- Test full iAssistant LLM workflow (non-streaming)
- Test iAssistant tool functionality
- Test authentication flow with real iFinder API

### End-to-End Tests

- Test complete user workflow from UI to iAssistant response
- Test streaming responses and SSE handling
- Test tool usage within larger conversation contexts

### Manual Testing Scenarios

1. **iAssistant as LLM**: Direct chat with iAssistant model
2. **iAssistant as Tool**: Other LLMs using iAssistant tool
3. **Authentication**: Anonymous vs authenticated user scenarios
4. **Error Conditions**: Network failures, invalid queries, permission errors
5. **Multi-user**: Concurrent requests from different users

## Deployment and Configuration

### Prerequisites

- iFinder API access with appropriate search profiles configured
- Private key for JWT signing (RS256)
- Network connectivity from AI Hub Apps to iFinder/iAssistant APIs

### Deployment Steps

1. **Backend Deployment**:
   - Deploy new adapter and handler code
   - Update configuration files
   - Add environment variables

2. **Model Registration**:
   - Add iAssistant model configuration
   - Enable model in platform settings
   - Test basic connectivity

3. **Tool Registration**:
   - Deploy iAssistant tool implementation
   - Update tools configuration
   - Test tool functionality

4. **Application Configuration**:
   - Deploy new app configurations
   - Enable apps for appropriate user groups
   - Configure starter prompts and guidance

### Configuration Validation

- Test JWT token generation with real private key
- Validate iAssistant API connectivity
- Confirm search profile access permissions
- Test authentication flow end-to-end

## Success Metrics and KPIs

### Usage Metrics

- Number of iAssistant interactions per day/week/month
- Ratio of direct iAssistant usage vs tool usage
- User adoption rate for iAssistant-enabled apps

### Performance Metrics

- Average response time for iAssistant queries
- Success rate of iAssistant API calls
- User satisfaction ratings for enterprise knowledge responses

### Business Impact

- Reduction in support tickets for information requests
- Increased self-service for enterprise knowledge
- User feedback on knowledge accessibility improvements

## Future Enhancements

### Phase 2 Enhancements

- **Conversation Context**: Implement context preservation across iAssistant interactions
- **Advanced Search**: Support for complex search filters and faceted search
- **Document Annotations**: Allow users to annotate and bookmark relevant documents

### Integration Improvements

- **Semantic Search**: Enhanced search capabilities with semantic understanding
- **Multi-modal Support**: Support for document images and multimedia content
- **Real-time Updates**: Push notifications for updated enterprise knowledge

### User Experience

- **Knowledge Graphs**: Visual representation of enterprise knowledge relationships
- **Personalization**: User-specific knowledge preferences and shortcuts
- **Collaborative Features**: Share knowledge discoveries with team members

## Conclusion

This implementation plan provides a comprehensive approach to integrating iAssistant as both an LLM adapter and a tool within AI Hub Apps. The design leverages existing infrastructure while accommodating iAssistant's unique characteristics, ensuring a seamless user experience and maintainable codebase.

The phased approach allows for incremental deployment and testing, minimizing risk while delivering immediate value to users seeking enterprise knowledge access. The robust error handling, security considerations, and performance optimizations ensure the integration will scale effectively in production environments.

Key success factors include proper authentication configuration, thorough testing of both LLM and tool usage patterns, and clear user guidance on when to use iAssistant versus other available models and tools.
