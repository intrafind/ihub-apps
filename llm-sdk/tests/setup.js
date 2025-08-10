/**
 * Test setup for LLM SDK
 */

// Mock console to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Mock performance if not available (Node.js < 16)
if (typeof global.performance === 'undefined') {
  global.performance = {
    now: () => Date.now()
  };
}

// Mock fetch for HTTP requests
global.fetch = jest.fn();

// Setup test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'ERROR'; // Reduce logging noise in tests

// Test utilities
global.createMockResponse = (data, status = 200) => {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Map([
      ['content-type', 'application/json']
    ])
  });
};

global.createMockStreamResponse = (chunks) => {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (index >= chunks.length) {
              return Promise.resolve({ done: true });
            }
            const chunk = chunks[index++];
            const encoder = new TextEncoder();
            return Promise.resolve({
              done: false,
              value: encoder.encode(chunk)
            });
          }
        };
      }
    }
  };
};

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
  
  // Reset environment variables
  const envVarsToClean = Object.keys(process.env).filter(key => 
    key.startsWith('LLM_SDK_') || 
    key.startsWith('OPENAI_') ||
    key.startsWith('ANTHROPIC_') ||
    key.startsWith('GOOGLE_') ||
    key.startsWith('MISTRAL_')
  );
  
  envVarsToClean.forEach(key => {
    delete process.env[key];
  });
});