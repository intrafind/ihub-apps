/**
 * Test fixtures for consistent test data across all test suites
 */

export const testUsers = {
  admin: {
    id: 'test-admin-001',
    username: 'test.admin@ihub.com',
    email: 'test.admin@ihub.com',
    groups: ['admin', 'users'],
    role: 'admin',
    isActive: true,
  },
  regularUser: {
    id: 'test-user-001',
    username: 'test.user@ihub.com',
    email: 'test.user@ihub.com',
    groups: ['users'],
    role: 'user',
    isActive: true,
  },
  financeUser: {
    id: 'test-finance-001',
    username: 'test.finance@ihub.com',
    email: 'test.finance@ihub.com',
    groups: ['finance', 'users'],
    role: 'user',
    isActive: true,
  },
  guest: {
    id: 'test-guest-001',
    username: 'guest',
    groups: [],
    role: 'guest',
    isActive: true,
  },
};

export const testApps = {
  generalChat: {
    id: 'test-general-chat',
    name: 'General Chat Assistant',
    description: 'A general-purpose chat assistant',
    groups: ['users'],
    model: 'gpt-4',
    systemPrompt: 'You are a helpful assistant.',
    isActive: true,
    tools: [],
  },
  financeApp: {
    id: 'test-finance-app',
    name: 'Finance Assistant',
    description: 'Financial analysis assistant',
    groups: ['finance'],
    model: 'gpt-4',
    systemPrompt: 'You are a financial analysis expert.',
    isActive: true,
    tools: ['calculator', 'data_lookup'],
  },
  adminApp: {
    id: 'test-admin-app',
    name: 'Admin Assistant',
    description: 'Administrative tasks assistant',
    groups: ['admin'],
    model: 'claude-3-sonnet-20240229',
    systemPrompt: 'You are an administrative assistant.',
    isActive: true,
    tools: ['user_management', 'system_monitoring'],
  },
};

export const testModels = {
  openai: {
    modelId: 'gpt-4',
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    displayName: 'GPT-4',
    isActive: true,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
  },
  anthropic: {
    modelId: 'claude-3-sonnet-20240229',
    provider: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    displayName: 'Claude 3 Sonnet',
    isActive: true,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
  },
  google: {
    modelId: 'gemini-1.5-flash',
    provider: 'google',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    displayName: 'Gemini 1.5 Flash',
    isActive: true,
    maxTokens: 8192,
    supportsTools: true,
    supportsStreaming: true,
  },
  mistral: {
    modelId: 'mistral-small-latest',
    provider: 'mistral',
    url: 'https://api.mistral.ai/v1/chat/completions',
    displayName: 'Mistral Small',
    isActive: true,
    maxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
  },
};

export const testTools = {
  webSearch: {
    name: 'web_search',
    description: 'Search the web for information',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
  },
  calculator: {
    name: 'calculator',
    description: 'Perform mathematical calculations',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate',
        },
      },
      required: ['expression'],
    },
  },
  dataLookup: {
    name: 'data_lookup',
    description: 'Look up data from internal systems',
    parameters: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'The table to query',
        },
        filters: {
          type: 'object',
          description: 'Filter conditions',
        },
      },
      required: ['table'],
    },
  },
};

export const testMessages = {
  simpleQuestion: [
    {
      role: 'user',
      content: 'Hello, how are you?',
    },
  ],
  toolCallingRequest: [
    {
      role: 'user',
      content: 'Search for information about machine learning trends in 2024',
    },
  ],
  complexConversation: [
    {
      role: 'user',
      content: 'I need to analyze our Q4 financial data.',
    },
    {
      role: 'assistant',
      content: 'I can help you analyze your Q4 financial data. What specific metrics would you like me to examine?',
    },
    {
      role: 'user',
      content: 'Show me the revenue growth compared to Q3.',
    },
  ],
};

export const testApiResponses = {
  chatCompletion: {
    id: 'chatcmpl-test-123',
    object: 'chat.completion',
    created: 1699999999,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'This is a test response from the assistant.',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    },
  },
  toolCallResponse: {
    id: 'chatcmpl-test-456',
    object: 'chat.completion',
    created: 1699999999,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_test_123',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: '{"query": "machine learning trends 2024"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
    },
  },
};

export const testEnvironment = {
  baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3000',
  frontendUrl: process.env.TEST_FRONTEND_URL || 'http://localhost:5173',
  apiTimeout: parseInt(process.env.TEST_API_TIMEOUT) || 30000,
  enableRealApiCalls: process.env.TEST_REAL_API === 'true',
  testModelProvider: process.env.TEST_MODEL_PROVIDER || 'mock',
};

export const mockApiKeys = {
  openai: 'sk-test-openai-key-12345',
  anthropic: 'sk-ant-test-key-12345',
  google: 'test-google-api-key-12345',
  mistral: 'test-mistral-key-12345',
};