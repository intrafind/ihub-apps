# Client Integration for Clarification Flow

**Date**: 2026-02-06
**Author**: Claude Code
**Status**: Implemented

## Overview

This document describes the client-side integration for the interactive user clarification feature. This feature enables LLMs to ask follow-up questions during a conversation to gather additional information before continuing their response.

## Architecture

### Event Flow

1. User sends a message
2. LLM determines it needs clarification and calls `ask_user` tool
3. Server sends `clarification` SSE event to client
4. Client displays `ClarificationCard` in the message
5. User answers the question (or skips)
6. Client sends new message with the answer
7. LLM continues with the gathered context

### Components Modified

#### 1. useEventSource Hook (`client/src/shared/hooks/useEventSource.js`)

Added `clarification` to the list of handled SSE events:

```javascript
const events = [
  'connected',
  'chunk',
  'done',
  'error',
  'processing',
  'image',
  'thinking',
  'clarification',  // New event
  // ... research events
];
```

#### 2. useAppChat Hook (`client/src/features/chat/hooks/useAppChat.js`)

Extended to handle clarification events and provide submission functionality:

**New State:**
- `clarificationPending` - Boolean indicating if a clarification is awaiting user input
- `activeClarificationRef` - Ref storing the current clarification data

**New Event Handler:**
```javascript
case 'clarification':
  if (lastMessageIdRef.current && data) {
    activeClarificationRef.current = data;
    setClarificationPending(true);
    updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
      clarification: {
        questionId: data.questionId,
        question: data.question,
        inputType: data.inputType || 'text',
        options: data.options || [],
        allowOther: data.allowOther || false,
        allowSkip: data.allowSkip || false,
        context: data.context
      },
      awaitingInput: true
    });
  }
  break;
```

**New Function:**
```javascript
submitClarificationResponse(response, params)
```

This function:
1. Updates the assistant message with the clarification response
2. Clears the clarification state
3. Creates a new user message showing the Q&A
4. Continues the conversation by sending the response to the server

**Updated Return:**
```javascript
return {
  // ... existing
  clarificationPending,
  submitClarificationResponse
};
```

#### 3. ChatMessage Component (`client/src/features/chat/components/ChatMessage.jsx`)

Added imports and props for clarification components:

```javascript
import ClarificationCard from './ClarificationCard';
import ClarificationResponse from './ClarificationResponse';

// New props
onClarificationSubmit = null,
onClarificationSkip = null
```

Added conditional rendering after the thoughts section:

```jsx
{/* Clarification UI */}
{!isUser && message.clarification && !message.clarificationResponse && (
  <ClarificationCard
    clarification={message.clarification}
    onSubmit={onClarificationSubmit}
    onSkip={onClarificationSkip}
  />
)}

{!isUser && message.clarification && message.clarificationResponse && (
  <ClarificationResponse
    question={message.clarification.question}
    response={message.clarificationResponse}
  />
)}
```

#### 4. ChatMessageList Component (`client/src/features/chat/components/ChatMessageList.jsx`)

Added pass-through props for clarification handlers:

```javascript
// New props
onClarificationSubmit = null,
onClarificationSkip = null

// Passed to ChatMessage
<ChatMessage
  // ... existing props
  onClarificationSubmit={onClarificationSubmit}
  onClarificationSkip={onClarificationSkip}
/>
```

#### 5. ChatInput Component (`client/src/features/chat/components/ChatInput.jsx`)

Added clarification-aware disabling:

```javascript
// New prop
clarificationPending = false

// Computed disabled state
const isInputDisabled = disabled || clarificationPending;

// Custom placeholder when clarification pending
if (clarificationPending) {
  defaultPlaceholder = t(
    'pages.appChat.answerQuestionAbove',
    'Please answer the question above to continue'
  );
}
```

#### 6. AppChat Page (`client/src/features/apps/pages/AppChat.jsx`)

Updated to use new hook values and pass handlers:

```javascript
const {
  // ... existing
  clarificationPending,
  submitClarificationResponse
} = useAppChat({ ... });

// Handler functions
const handleClarificationSubmit = useCallback((response) => {
  const params = { modelId, style, temperature, outputFormat, language };
  submitClarificationResponse(response, params);
}, [submitClarificationResponse, ...]);

const handleClarificationSkip = useCallback((response) => {
  const params = { modelId, style, temperature, outputFormat, language };
  submitClarificationResponse(response, params);
}, [submitClarificationResponse, ...]);

// Passed to ChatMessageList and ChatInput
<ChatMessageList
  // ... existing
  onClarificationSubmit={handleClarificationSubmit}
  onClarificationSkip={handleClarificationSkip}
/>

<ChatInput
  // ... existing
  clarificationPending={clarificationPending}
/>
```

### Clarification UI Components

The clarification UI is provided by components at:
- `client/src/features/chat/components/ClarificationCard.jsx`
- `client/src/features/chat/components/ClarificationChips.jsx`
- `client/src/features/chat/components/ClarificationDropdown.jsx`
- `client/src/features/chat/components/ClarificationInput.jsx`
- `client/src/features/chat/components/ClarificationResponse.jsx`

These components support:
- Single select (chips for <= 4 options, dropdown for more)
- Multi select
- Text input
- Number input
- Date input
- Date range input
- File input (placeholder)
- "Other" option with custom input
- Skip functionality
- Keyboard navigation (Ctrl/Cmd + Enter to submit)
- Full accessibility (ARIA attributes, focus trapping)

### Message Schema Extensions

Messages with clarifications have these additional properties:

```typescript
interface Message {
  // ... existing properties

  clarification?: {
    questionId: string;
    question: string;
    inputType: 'text' | 'single_select' | 'multi_select' | 'number' | 'date' | 'date_range' | 'file';
    options?: Array<{ label: string; value: string; description?: string }>;
    allowOther?: boolean;
    allowSkip?: boolean;
    context?: string;
  };

  clarificationResponse?: {
    answered: boolean;
    skipped: boolean;
    value: any;
    displayText: string;
    answeredAt: number;
  };

  awaitingInput?: boolean;
}
```

## Server Contract

The server sends clarification events in this format:

```json
{
  "type": "clarification",
  "data": {
    "questionId": "unique-id",
    "question": "What format would you like the report in?",
    "inputType": "single_select",
    "options": [
      { "label": "PDF", "value": "pdf" },
      { "label": "Excel", "value": "xlsx" }
    ],
    "allowOther": true,
    "allowSkip": false,
    "context": "This will determine the output format."
  }
}
```

When the user responds, the client sends the response as part of a new chat message with `clarificationResponse` in the params:

```json
{
  "clarificationResponse": {
    "questionId": "unique-id",
    "answered": true,
    "skipped": false,
    "value": "pdf"
  }
}
```

## i18n Keys

New translation keys added:

- `pages.appChat.answerQuestionAbove` - Placeholder when clarification pending
- `clarification.skip` - Skip button text
- `clarification.submit` - Submit button text
- `clarification.submitting` - Submitting state text
- `clarification.skipped` - Skipped status text
- `clarification.questionPrefix` - Question label
- `clarification.answerPrefix` - Answer label
- `clarification.keyboardHint` - Keyboard shortcut hint
- `clarification.fileUploadPlaceholder` - File upload placeholder

## Testing

To test the clarification flow:

1. Configure an app with the `ask_user` tool enabled
2. Send a message that would trigger a clarification
3. Verify the ClarificationCard appears in the chat
4. Test answering with different input types
5. Test the skip functionality
6. Verify the conversation continues after answering

## Future Improvements

1. Implement actual file upload for file input type
2. Add validation feedback for invalid inputs
3. Support for nested/conditional clarifications
4. Auto-focus improvements for accessibility
5. Mobile-optimized layouts for complex inputs
