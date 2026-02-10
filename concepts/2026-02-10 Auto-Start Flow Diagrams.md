# Auto-Start Feature Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      User Opens App                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │   AppChat Component   │
                │      Initializes      │
                └───────────┬───────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │  Load App Config      │
                │  - Get app details    │
                │  - Check autoStart    │
                └───────────┬───────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Auto-Start    │
                    │ Enabled?      │
                    └───┬───────┬───┘
                        │       │
                   Yes  │       │  No
                        │       │
                        ▼       ▼
        ┌───────────────────┐ ┌───────────────────┐
        │ Check Conditions  │ │ Show Normal       │
        │ - messages = 0    │ │ Empty State       │
        │ - !processing     │ │ (greeting/        │
        │ - model loaded    │ │  starter prompts) │
        │ - !triggered      │ └───────────────────┘
        └─────────┬─────────┘
                  │
                  ▼
          ┌───────────────┐
          │ All OK?       │
          └───┬───────┬───┘
              │       │
         Yes  │       │  No
              │       │
              ▼       ▼
    ┌─────────────────┐  ┌──────────────┐
    │ Wait 300ms      │  │ Wait for     │
    │ for Init        │  │ Dependencies │
    └────────┬────────┘  └──────────────┘
             │
             ▼
    ┌─────────────────┐
    │ Send Empty      │
    │ Message to LLM  │
    │ - content: ""   │
    │ - with params   │
    │ - with vars     │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ useAppChat Hook │
    │ sendMessage()   │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────────────┐
    │ Add Messages to State   │
    │ 1. User msg (empty)     │
    │ 2. Assistant placeholder│
    └────────┬────────────────┘
             │
             ▼
    ┌─────────────────┐
    │ Send to API     │
    │ POST /apps/     │
    │   {appId}/chat/ │
    │   {chatId}      │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ LLM Processes   │
    │ - Empty input   │
    │ - System prompt │
    │ - Variables     │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Stream Response │
    │ (EventSource)   │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────────┐
    │ ChatMessageList     │
    │ Filters Messages    │
    │ - Skip empty user   │
    │ - Show assistant    │
    └────────┬────────────┘
             │
             ▼
    ┌─────────────────┐
    │ Display to User │
    │ Only AI Greeting│
    └─────────────────┘
```

## Component Interaction

```
┌──────────────────────────────────────────────────────────────┐
│                         AppChat.jsx                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ useEffect - Auto-Start Trigger                         │ │
│  │  - Watches: app, messages, processing, dependencies    │ │
│  │  - Condition: autoStart=true && messages.length=0      │ │
│  │  - Action: sendChatMessage({ content: "" })            │ │
│  └──────────────────┬─────────────────────────────────────┘ │
│                     │                                        │
│                     │ calls                                  │
│                     ▼                                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ useAppChat Hook                                        │ │
│  │  - sendMessage()                                       │ │
│  │  - addUserMessage(displayMessage)                      │ │
│  │  - addAssistantMessage(exchangeId)                     │ │
│  │  - initEventSource()                                   │ │
│  └──────────────────┬─────────────────────────────────────┘ │
└───────────────────┬─┴──────────────────────────────────────┬┘
                    │                                        │
        updates     │                                        │ reads
                    │                                        │
                    ▼                                        │
┌──────────────────────────────────────┐                     │
│ useChatMessages Hook                 │                     │
│  - messages state                    │                     │
│  - sessionStorage persistence        │                     │
│  - addUserMessage()                  │◄────────────────────┘
│  - addAssistantMessage()             │
│  - updateAssistantMessage()          │
└──────────────────┬───────────────────┘
                   │
       provides    │
                   ▼
┌──────────────────────────────────────┐
│ ChatMessageList.jsx                  │
│  ┌────────────────────────────────┐  │
│  │ Filter Logic                   │  │
│  │  displayedMessages = messages  │  │
│  │    .filter(m =>                │  │
│  │      !(m.role === 'user' &&    │  │
│  │        m.content.trim() === '')│  │
│  │    )                           │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ Render                         │  │
│  │  displayedMessages.map(...)    │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

## State Flow

```
Initial State:
messages = []
autoStartTriggered = false
processing = false

↓ User opens app with autoStart: true

Auto-Start Triggered:
messages = []
autoStartTriggered = true
processing = false

↓ Send empty message

During Send:
messages = [
  { role: 'user', content: '', id: 'msg-123' },
  { role: 'assistant', content: '', loading: true, id: 'msg-124' }
]
autoStartTriggered = true
processing = true

↓ Receive streaming response

During Stream:
messages = [
  { role: 'user', content: '', id: 'msg-123' },
  { role: 'assistant', content: 'Hello! How can...', loading: true, id: 'msg-124' }
]
processing = true

↓ Stream complete

Final State:
messages = [
  { role: 'user', content: '', id: 'msg-123' },
  { role: 'assistant', content: 'Hello! How can I help you today?', loading: false, id: 'msg-124' }
]
processing = false

↓ ChatMessageList filters

Displayed:
messages = [
  { role: 'assistant', content: 'Hello! How can I help you today?', loading: false, id: 'msg-124' }
]
```

## Timing Sequence

```
Time (ms)  Event
─────────  ──────────────────────────────────────────
0          AppChat component mounts
50         App config loads
100        useAppChat hook initializes
150        useChatMessages hook loads from storage (empty)
200        Dependencies ready (model, variables)
250        Auto-start conditions check passes
300        Delay timer expires
300        sendChatMessage() called
305        User message added to state
310        Assistant placeholder added to state
315        API request sent
500        API response starts streaming
550        First chunk received
650        More chunks received
1200       Stream completes
1205       Assistant message marked complete
1205       ChatMessageList filters empty user message
1210       Only assistant greeting visible to user
```

## Configuration Schema

```javascript
// App Config
{
  "id": "my-coach",
  "name": { "en": "Coach" },
  "system": { "en": "You are a helpful coach. Start by greeting..." },
  
  "autoStart": true,  // ← New field
  
  "tokenLimit": 8192,
  "enabled": true
}
```

## Admin UI Structure

```
┌─────────────────────────────────────────────────────┐
│ App Form Editor                                     │
│                                                     │
│ Basic Information Section                          │
│  ┌─────────────────────────────────────────────┐  │
│  │ App ID: [my-coach              ]            │  │
│  │ Name: [Coach                   ]            │  │
│  │ ...                                         │  │
│  │                                             │  │
│  │ ☑ Enabled                                   │  │
│  │                                             │  │
│  │ ☑ Auto-start conversation                  │  │ ← New
│  │   When enabled, the app will automatically  │  │
│  │   start the conversation when the chat is   │  │
│  │   opened or reset                           │  │
│  └─────────────────────────────────────────────┘  │
│                                                     │
│ System Instructions Section                        │
│  ...                                               │
└─────────────────────────────────────────────────────┘
```
