# iAssistant Integration - Test-Driven Development Guide

## Overview

This guide documents the test-driven development (TDD) approach for integrating iAssistant into AI Hub Apps as both an LLM adapter and a tool. By writing tests first, we ensure our implementation meets all requirements and handles edge cases properly.

## Key Design Decisions

### 1. No System Instructions in API
The iAssistant API doesn't support passing system instructions separately. Instead:
- Conversation context is combined into a single prompt
- The `question` field contains the current user query
- Previous conversation context is passed as additional context

### 2. Non-Conversational Nature
iAssistant doesn't maintain conversation state, so we:
- Combine all previous messages into a context string
- Pass this context along with the current question
- Each request is independent

### 3. User Authentication Required
- All requests must be made with authenticated users
- Anonymous access is not supported
- JWT tokens are generated per-request using the existing iFinder JWT utilities

## Test Structure

### 1. Unit Tests (`iassistantAdapter.test.js`)

Tests the core adapter functionality:
- Message formatting for non-conversational API
- Authentication requirements
- Request creation with proper headers
- Streaming response parsing (answer, telemetry, passages, related questions)
- Non-streaming mode support
- Error handling scenarios

**Key Test Cases:**
```javascript
// Single message formatting
{ question: "What is X?", conversationContext: "" }

// Multi-turn formatting
{ 
  question: "Tell me more", 
  conversationContext: "Previous conversation:\nuser: What is X?\nassistant: X is..."
}
```

### 2. Tool Tests (`iassistantTool.test.js`)

Tests the tool interface for use by other LLMs:
- `askQuestion` functionality with all parameters
- `getDocumentContext` for specific document retrieval
- Authentication and parameter validation
- Response structure with sources and metadata
- Timeout handling
- Tool metadata structure

**Key Functions:**
```javascript
// Ask a question
await iAssistantTool.askQuestion({
  query: "What is the policy?",
  user: authenticatedUser,
  chatId: "chat-123",
  profileId: "searchprofile-hr" // optional
});

// Get specific documents
await iAssistantTool.getDocumentContext({
  documentIds: ["doc1", "doc2"],
  user: authenticatedUser,
  chatId: "chat-123"
});
```

### 3. Integration Tests (`iassistantIntegration.test.js`)

Tests the full end-to-end flow:
- Mock RAG API server setup
- Streaming SSE event handling
- Adapter registration and retrieval
- Full chat service integration
- Error recovery scenarios

## Implementation Checklist

Based on the tests, here's what needs to be implemented:

### Phase 1: Core Adapter Implementation
- [ ] Create `server/adapters/iassistant.js`
  - [ ] Extend BaseAdapter
  - [ ] Implement `formatMessages()` for context combination
  - [ ] Implement `createCompletionRequest()` with RAG API structure
  - [ ] Implement `processResponseBuffer()` for SSE parsing
  - [ ] Add authentication checks

### Phase 2: Custom Request Handler
- [ ] Create `server/services/chat/IAssistantHandler.js`
  - [ ] Handle RAG API client registration
  - [ ] Manage SSE connections
  - [ ] Convert RAG events to LLM streaming format
  - [ ] Implement cleanup on disconnect

### Phase 3: Tool Implementation
- [ ] Create `server/tools/iAssistant.js`
  - [ ] Implement `askQuestion` function
  - [ ] Implement `getDocumentContext` function
  - [ ] Add proper metadata structure
  - [ ] Handle authentication and validation

### Phase 4: Configuration
- [ ] Add to `server/adapters/index.js` registry
- [ ] Create `contents/models/iassistant-enterprise.json`
- [ ] Update `contents/config/platform.json` with iAssistant settings
- [ ] Add to `contents/config/tools.json`

### Phase 5: Applications
- [ ] Create enterprise knowledge app
- [ ] Create document research app
- [ ] Test with real iAssistant instance

## Running the Tests

### Individual Tests
```bash
# Run adapter tests
node server/tests/iassistantAdapter.test.js

# Run tool tests  
node server/tests/iassistantTool.test.js

# Run integration tests
node server/tests/iassistantIntegration.test.js
```

### All Tests
```bash
# Run complete test suite
node server/tests/runIAssistantTests.js

# Or via npm (after adding to package.json)
npm run test:iassistant
```

## Expected Test Output

When all tests pass, you should see:
```
🚀 Running iAssistant Tests Suite
==================================================

📦 iAssistant Adapter Tests
📝 Testing LLM adapter functionality
--------------------------------------------------
🧪 Testing iAssistant Adapter

📋 Test 1: Message Formatting for Non-Conversational API
✅ Single message formatting test passed
✅ Multi-turn message formatting test passed

📋 Test 2: Request Creation with Authentication
✅ Authentication requirement test passed
✅ Request creation test passed

📋 Test 3: Streaming Response Processing
✅ Answer event processing test passed
✅ Telemetry event processing test passed
✅ Passages event processing test passed
✅ Related questions event processing test passed
✅ Complete event processing test passed

📋 Test 4: Non-Streaming Mode
✅ Non-streaming mode test passed

📋 Test 5: Error Scenarios
✅ Anonymous user rejection test passed
✅ Missing chatId test passed

🎉 All iAssistant adapter tests passed!

✅ iAssistant Adapter Tests - PASSED

[Similar output for Tool and Integration tests...]

==================================================
📊 Test Summary
==================================================
✅ Passed: 3
❌ Failed: 0
📈 Total: 3
🎯 Success Rate: 100.0%

🎉 All tests passed! iAssistant integration is ready.
```

## Benefits of TDD Approach

1. **Clear Requirements**: Tests define exactly what the implementation needs to do
2. **Edge Case Coverage**: Tests ensure error scenarios are handled properly
3. **Regression Prevention**: Tests catch breaking changes during implementation
4. **Documentation**: Tests serve as living documentation of the API
5. **Confidence**: Green tests give confidence the implementation works correctly

## Next Steps

1. Add the test script to package.json:
```json
"test:iassistant": "node server/tests/runIAssistantTests.js"
```

2. Run tests to see them fail (expected since implementation doesn't exist yet)

3. Implement each component following the test requirements

4. Run tests after each implementation phase to verify correctness

5. Refactor as needed while keeping tests green

## Troubleshooting

### Common Test Failures

1. **Authentication Errors**: Ensure mock JWT generation is working
2. **Timeout Issues**: Check async/await usage in tests
3. **Mock Server Issues**: Verify the mock RAG server is starting/stopping properly
4. **Event Parsing**: Ensure SSE event format matches the actual RAG API

### Debugging Tips

- Add console.log statements in tests to see intermediate values
- Use `--inspect` flag to debug with Chrome DevTools
- Run individual test files to isolate issues
- Check mock implementations match expected behavior