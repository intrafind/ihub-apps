# Interactive User Clarification Tool (`ask_user`)

**Date:** 2026-02-06
**Status:** Implemented
**Author:** Product & Engineering

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Execution model** | Answer treated as new message | Simplifies architecture - no complex state serialization needed |
| **Multi-question handling** | Sequential (one at a time) | Better UX, LLM can adapt follow-ups |
| **Rate limiting** | Hard limit (10 per conversation) | Security requirement |
| **UI behavior** | Blocking | Natural since LLM waits for answer |

## Overview

The `ask_user` tool enables AI apps to ask users clarifying questions mid-conversation through structured UI elements (chips, dropdowns, inputs).

## Implementation Summary

### Server-Side
- `server/tools/askUser.js` - Tool definition with validation
- `server/services/chat/ToolExecutor.js` - Clarification event handling
- `server/actionTracker.js` - Clarification event tracking
- `shared/unifiedEventSchema.js` - CLARIFICATION event type

### Client-Side Components
- `ClarificationCard.jsx` - Main container with accessibility
- `ClarificationChips.jsx` - Chip selector (≤4 options)
- `ClarificationDropdown.jsx` - Dropdown (>4 options)
- `ClarificationInput.jsx` - Text/number/date inputs
- `ClarificationResponse.jsx` - Answered Q&A display

### Client-Side Integration
- `useAppChat.js` - Clarification event handler and state
- `ChatMessage.jsx` - Renders clarification components
- `ChatInput.jsx` - Disabled during pending clarification
- `AppChat.jsx` - Wires everything together

## Question Types

| Type | UI Component |
|------|--------------|
| `single_select` | Chips or dropdown |
| `multi_select` | Chips with checkmarks |
| `text` | Textarea |
| `number` | Number input |
| `date` | Date picker |
| `date_range` | Dual date pickers |

## Security

- XSS prevention with DOMPurify
- ReDoS protection with safe-regex
- Rate limiting (max 10 per conversation)
- Input validation

## Accessibility (WCAG 2.1 AA)

- `role="dialog"`, `aria-modal="true"`
- Focus trapping
- Keyboard navigation
- 44x44px minimum touch targets
