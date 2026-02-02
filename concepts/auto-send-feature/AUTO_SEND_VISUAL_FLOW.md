# Auto-Send Feature - Visual Flow

## URL Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  User opens URL:                                                 │
│  /apps/platform?prefill=Welche quellen kennst du?&send=true    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AppChat Component Loads                                         │
│  - prefillMessage = "Welche quellen kennst du?"                 │
│  - send parameter = "true"                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Query Parameters Processed                                      │
│  - Input field filled with prefill message                       │
│  - Other parameters applied (model, style, etc.)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Auto-Send useEffect Checks Conditions                          │
│  ✓ send=true present                                            │
│  ✓ Not already triggered                                        │
│  ✓ Prefill message exists                                       │
│  ✓ App is loaded                                                │
│  ✓ Not currently processing                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Auto-Send Actions                                               │
│  1. Set autoSendTriggered = true                                │
│  2. Remove 'send' from URL                                       │
│  3. Wait 100ms                                                   │
│  4. Dispatch form submit event                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Message Sent to AI                                              │
│  URL is now: /apps/platform                                      │
│  (send parameter removed)                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI Responds                                                     │
│  Conversation continues normally                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Component State Flow

```
INITIAL STATE
┌────────────────────────┐
│ autoSendTriggered.current = false │
│ searchParams has 'send=true'      │
│ prefillMessage = "..."            │
│ app = loaded                      │
│ processing = false                │
└────────────────────────┘
         │
         ▼
AUTO-SEND TRIGGERED
┌────────────────────────┐
│ autoSendTriggered.current = true  │
│ searchParams 'send' removed       │
│ Form submit dispatched           │
└────────────────────────┘
         │
         ▼
AFTER SEND
┌────────────────────────┐
│ autoSendTriggered.current = true  │
│ processing = true                 │
│ URL clean (no 'send' param)      │
└────────────────────────┘
```

## Safety Guards

```
┌─────────────────────────────────────────────┐
│  Condition Checks (ALL must be true)        │
├─────────────────────────────────────────────┤
│  1. searchParams.get('send') === 'true'     │
│     ↓ Ensures send parameter is present     │
│                                             │
│  2. !autoSendTriggered.current              │
│     ↓ Prevents multiple executions          │
│                                             │
│  3. prefillMessage                          │
│     ↓ Ensures there's a message to send     │
│                                             │
│  4. app                                     │
│     ↓ Ensures app is loaded                 │
│                                             │
│  5. !processing                             │
│     ↓ Ensures not already processing        │
└─────────────────────────────────────────────┘
```

## Edge Cases Handled

### Case 1: App Switch
```
User on /apps/app1?send=true → switches to /apps/app2?send=true
                │
                ▼
        appId changes
                │
                ▼
   autoSendTriggered reset to false
                │
                ▼
      Auto-send can trigger again
```

### Case 2: Page Refresh
```
User on /apps/app1?prefill=test&send=true
                │
                ▼
        Auto-send triggers
                │
                ▼
   URL becomes /apps/app1?prefill=test
                │
                ▼
        User refreshes page
                │
                ▼
   No 'send' param → Auto-send does NOT trigger
```

### Case 3: Back Button
```
User visits /apps/app1?send=true
                │
                ▼
        Auto-send triggers
                │
                ▼
   Component unmounts (navigate away)
                │
                ▼
     User clicks back button
                │
                ▼
   Component remounts, ref reset
                │
                ▼
   URL has no 'send' → No auto-send
```
