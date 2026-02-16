# Workflow Authoring Guide

This guide covers how to write workflow definitions for the iHub Apps agentic workflow system.

## Workflow Structure

A workflow consists of **nodes** (processing steps) connected by **edges** (transitions). Every workflow must have exactly one `start` node and at least one `end` node.

```json
{
  "id": "my-workflow",
  "name": { "en": "My Workflow" },
  "description": { "en": "Description of what this workflow does" },
  "version": "1.0.0",
  "config": {
    "maxExecutionTime": 300000,
    "defaultModelId": "gemini-2.0-flash",
    "maxIterations": 10
  },
  "sources": ["compliance-rules"],
  "nodes": [...],
  "edges": [...]
}
```

## Workflow-Level Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `config.maxExecutionTime` | number | 300000 | Max total execution time in ms (enforced by engine) |
| `config.defaultModelId` | string | - | Default model for agent nodes that don't specify their own |
| `config.maxIterations` | number | 10 | Max times any single node can execute (loop protection) |
| `config.allowCycles` | boolean | true | Allow loops in the workflow graph |
| `sources` | string[] | - | Source IDs to load and make available to agent nodes |

## Variable Flow Between Nodes

Variables flow through workflow state (`state.data`). Each node can read from and write to this shared state.

### Setting Variables

Agent nodes store their output using `outputVariable`:

```json
{
  "id": "research-agent",
  "type": "agent",
  "config": {
    "prompt": { "en": "Research {{topic}}" },
    "outputVariable": "researchResults"
  }
}
```

After execution, `state.data.researchResults` contains the agent's response.

### Reading Variables

Use `{{variableName}}` template syntax in prompts:

```json
{
  "id": "summary-agent",
  "type": "agent",
  "config": {
    "prompt": { "en": "Summarize these findings:\n\n{{researchResults}}" }
  }
}
```

### Start Node Input Variables

The start node defines user-facing input fields:

```json
{
  "id": "start",
  "type": "start",
  "config": {
    "inputVariables": [
      {
        "name": "topic",
        "type": "text",
        "label": { "en": "Research Topic" },
        "required": true
      },
      {
        "name": "document",
        "type": "file",
        "label": { "en": "Upload Document" },
        "accept": ["application/pdf", "text/plain"],
        "maxSizeMB": 10
      },
      {
        "name": "photo",
        "type": "image",
        "label": { "en": "Upload Image" },
        "maxSizeMB": 5
      }
    ]
  }
}
```

**Supported variable types**: `text`, `textarea`, `number`, `date`, `boolean`, `select`, `file`, `image`

### File and Image Variables

File/image variables are stored as objects in state:

**Document files** (PDF, DOCX, TXT):
```json
{
  "type": "document",
  "fileName": "contract.pdf",
  "fileType": "application/pdf",
  "content": "... extracted text ...",
  "displayType": "PDF"
}
```

**Image files** (JPEG, PNG, WebP):
```json
{
  "type": "image",
  "base64": "data:image/png;base64,...",
  "fileName": "photo.png"
}
```

To use file data in an agent node, reference it via `inputFiles`:

```json
{
  "id": "analyzer",
  "type": "agent",
  "config": {
    "inputFiles": ["document"],
    "prompt": { "en": "Analyze the uploaded document and extract key findings." }
  }
}
```

The executor will prepend text file content or add image data as multimodal content automatically.

## Template Syntax

### Simple Variables
```
{{variableName}}           → value from state.data.variableName
{{nested.path.value}}      → nested property access
```

### Conditionals
```
{{#if hasResults}}
Results found: {{results}}
{{/if}}
```

### Loops
```
{{#each items}}
- Item {{@index}}: {{this.name}} - {{this.description}}
{{/each}}
```

### Comparisons
```
{{#compare score ">" 80}}
High score achieved!
{{/compare}}
```

Supported operators: `<`, `>`, `<=`, `>=`, `==`, `!=`, `===`, `!==`

## Step Counter Variables

The engine exposes convenience variables for tracking execution progress:

| Variable | Description |
|----------|-------------|
| `{{_currentStep}}` | Number of nodes executed so far (1-based) |
| `{{_currentNodeIteration}}` | Current iteration count for this specific node |
| `{{_totalNodes}}` | Total number of processing nodes (excludes start/end) |

Example usage in a prompt:
```
Step {{_currentStep}} of {{_totalNodes}}: Review the research findings.
This is iteration {{_currentNodeIteration}} of this review step.
```

## Source Integration

Sources provide reference content (knowledge bases, rules, guidelines) to agent nodes.

### Workflow-Level Sources

Define sources at the workflow level - all agent nodes can access them:

```json
{
  "id": "compliance-check",
  "sources": ["compliance-rules", "style-guide"],
  "nodes": [...]
}
```

### Node-Level Sources

Override workflow sources for specific nodes:

```json
{
  "id": "rule-checker",
  "type": "agent",
  "config": {
    "sources": ["specific-ruleset"],
    "system": { "en": "Check compliance against:\n{{sources}}" }
  }
}
```

### Source Content in Prompts

Source content is injected into system prompts:
- If `{{sources}}` placeholder exists → replaced with content
- If `{{source}}` placeholder exists → replaced with content (legacy)
- If no placeholder → appended after the system prompt

Source content is cached per execution - multiple nodes referencing the same sources won't reload them.

## Model Resolution

Agent nodes resolve their LLM model in this priority order:

1. **Node config** `modelId` - explicit per-node override
2. **User selection** `_modelOverride` - user's choice at workflow start
3. **Workflow config** `defaultModelId` - workflow-level default
4. **Context model** - from execution context
5. **Platform default** - first default model or first available model

## Common Patterns

### Linear Pipeline

```
[start] → [agent-1] → [agent-2] → [agent-3] → [end]
```

Each agent reads the previous agent's output via `outputVariable` and `{{variable}}`.

### Decision Branch

```
[start] → [analyzer] → [decision] → [path-a] → [end]
                                   → [path-b] → [end]
```

The decision node evaluates conditions on edge configurations to route the workflow.

### Revision Loop

```
[start] → [writer] → [reviewer] → [decision] → [end] (if approved)
                                              → [writer] (if needs revision)
```

The reviewer checks quality. If revision is needed, the workflow loops back to the writer. Protected by `maxIterations`.

### Human Checkpoint

```
[start] → [agent] → [human] → [agent-2] → [end]
```

The human node pauses execution and waits for user response before continuing.

## Execution Configuration

Each node can have execution-level settings:

```json
{
  "id": "critical-agent",
  "type": "agent",
  "execution": {
    "timeout": 60000,
    "retries": 2,
    "retryDelay": 2000
  },
  "config": { ... }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `timeout` | 30000 | Node execution timeout in ms |
| `retries` | 0 | Number of retry attempts on failure |
| `retryDelay` | 1000 | Delay between retries in ms |

## State Size Constraints

Workflow state has a 50MB limit (`MAX_STATE_SIZE`). Extracted text from documents is typically <1MB. Base64 images are 1-5MB. Keep this in mind when designing workflows that process multiple large files.
