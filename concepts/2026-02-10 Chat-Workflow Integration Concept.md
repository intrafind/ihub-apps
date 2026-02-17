# Chat-Workflow Integration Concept

**Status**: Future implementation (Phases 4-5)
**Date**: 2026-02-10

## Overview

This document describes the planned integration between the chat system and the workflow engine, enabling workflows to be triggered from chat conversations and their results displayed inline.

## Three Trigger Modes

### 1. User-Initiated
User explicitly references or selects a workflow to run from the chat interface.

### 2. System-Recommended
The system suggests running a workflow based on conversation context. User confirms before execution starts.

### 3. LLM-Decided (Workflows as Tools)
The LLM autonomously decides to start a workflow, similar to how it calls other tools. This is the most elegant approach and leverages existing tool infrastructure.

## Architecture: Workflows as Tools

### Registration

A new tool type `workflow` is registered in the tool system. Each enabled workflow with `exposeAsAgent: true` becomes a callable tool:

- **Tool name**: workflow ID (e.g., `workflow:document-compliance`)
- **Tool description**: workflow description (localized)
- **Tool parameters**: derived from the start node's `inputVariables` schema

### LLM Integration

When a chat app has `tools: ["workflow:document-compliance"]` in its config:

1. The LLM can decide to call it like any other tool
2. The tool executor starts the workflow via `WorkflowEngine.start()`
3. Waits for completion (with timeout)
4. Returns the workflow output as the tool result
5. The LLM formats and presents the result to the user

### SSE Bridging

Workflow progress events are forwarded to the chat's SSE connection:

```
WorkflowEngine._emitEvent()
  → actionTracker.emit('fire-sse', {chatId: executionId})
    ↓ bridge listener
  → actionTracker.emit('fire-sse', {chatId: chatSessionId, type: 'workflow.progress'})
    ↓
  → Chat SSE handler → client renders progress
```

### Human Checkpoints in Chat

When a workflow pauses for human input during a chat session:
- The chat shows checkpoint options inline (approve/reject/feedback)
- User responds in the chat interface
- Response forwarded via `POST /workflows/executions/:id/respond`
- Workflow resumes

## Key Files to Modify (Future)

| File | Changes |
|------|---------|
| `server/routes/chat/sessionRoutes.js` | New workflow-in-chat endpoint |
| `server/services/chat/ChatService.js` | Recognize workflow tools |
| `server/toolLoader.js` | Register workflow tools |
| `client/src/features/apps/pages/AppChat.jsx` | Handle workflow progress events |
| `server/tools/workflowRunner.js` (new) | Tool executor that starts workflows |
| `client/src/features/apps/components/WorkflowProgressInline.jsx` (new) | Compact progress UI |

## Document Compliance Workflow

### ComplianceReport Schema

```json
{
  "title": "Compliance Report",
  "documentName": "contract.pdf",
  "summary": { "pass": 5, "warn": 2, "fail": 1, "total": 8 },
  "rules": [
    {
      "id": "rule-1",
      "name": "Data Privacy Clause",
      "status": "pass|warn|fail",
      "description": "Assessment description",
      "citation": "Section 4.2, paragraph 3",
      "evidence": "Quoted text from document"
    }
  ]
}
```

### Simple Workflow (single-call)
```
[start: document + rules source] → [compliance-check: single agent] → [end: report]
```

### Thorough Workflow (per-rule loop)
```
[start] → [analyze-doc] → [init-rules] → [check-rule] → [accumulate]
  → [more-rules?] → loop/[build-report] → [end]
```

### Chat App Configuration
```json
{
  "id": "document-compliance",
  "name": { "en": "Document Compliance Check" },
  "tools": ["workflow:document-compliance"],
  "upload": { "enabled": true, "fileUpload": { "supportedFormats": ["application/pdf"] } },
  "customRenderer": "compliance-report"
}
```

### Custom Renderer
A JSX component at `contents/renderers/compliance-report.jsx` would render:
- Summary bar with colored pass/warn/fail badges
- Expandable cards per rule with status indicator
- Evidence citations
