# Node Executors Implementation

**Date:** 2026-02-06
**Component:** Workflow System - Node Executors
**Location:** `/server/services/workflow/executors/`

## Overview

This document describes the node executor classes for the workflow system. Node executors are responsible for executing specific types of nodes in a workflow DAG (Directed Acyclic Graph).

## Architecture

### Class Hierarchy

```
BaseNodeExecutor (abstract base class)
├── StartNodeExecutor   - Workflow entry point
├── EndNodeExecutor     - Workflow exit point
├── AgentNodeExecutor   - LLM agent with tools
├── ToolNodeExecutor    - Direct tool invocation
└── DecisionNodeExecutor - Conditional branching
```

### File Structure

```
server/services/workflow/executors/
├── index.js                  - Exports and factory function
├── BaseNodeExecutor.js       - Abstract base class
├── StartNodeExecutor.js      - Entry point executor
├── EndNodeExecutor.js        - Exit point executor
├── AgentNodeExecutor.js      - LLM agent executor
├── ToolNodeExecutor.js       - Tool executor
└── DecisionNodeExecutor.js   - Decision executor
```

## Executor Types

### 1. StartNodeExecutor

**Purpose:** Initialize workflow state with input data.

**Configuration:**
- `inputMapping` - Map initial data fields to state variables
- `defaults` - Default values for state variables
- `requiredInputs` - List of required input field names

**Example:**
```javascript
{
  id: 'start',
  type: 'start',
  name: 'Workflow Start',
  config: {
    inputMapping: {
      query: '$.input.userQuery',
      context: '$.input.additionalContext'
    },
    defaults: {
      maxResults: 10
    },
    requiredInputs: ['userQuery']
  }
}
```

### 2. EndNodeExecutor

**Purpose:** Collect final output and signal workflow completion.

**Configuration:**
- `outputMapping` - Map state fields to output fields
- `includeFields` - Specific fields to include in output
- `excludeFields` - Fields to exclude from output
- `outputFormat` - Output format ('json', 'text', 'raw')
- `includeMetadata` - Include execution metadata

**Example:**
```javascript
{
  id: 'end-success',
  type: 'end',
  name: 'Success Exit',
  config: {
    outputMapping: {
      result: '$.data.processedResult',
      summary: '$.nodeOutputs.summarizer.content'
    },
    outputFormat: 'json'
  }
}
```

### 3. AgentNodeExecutor

**Purpose:** Execute LLM calls with optional tool access.

**Configuration:**
- `system` - System prompt for the agent
- `prompt` - User prompt template (supports variable references)
- `tools` - Tool IDs available to this agent
- `modelId` - Specific model to use
- `temperature` - Temperature for LLM responses
- `maxTokens` - Maximum tokens for response
- `maxIterations` - Maximum tool calling iterations (default: 10)
- `outputSchema` - JSON schema for structured output
- `outputVariable` - State variable to store the result
- `includeHistory` - Include previous messages in context

**Example:**
```javascript
{
  id: 'research-agent',
  type: 'agent',
  name: 'Research Agent',
  config: {
    system: 'You are a research assistant.',
    prompt: 'Research: ${$.data.topic}',
    tools: ['source_search', 'web_search'],
    modelId: 'gpt-4',
    maxIterations: 5,
    outputVariable: 'researchResults'
  }
}
```

### 4. ToolNodeExecutor

**Purpose:** Direct tool invocation without LLM.

**Configuration:**
- `toolId` - The tool identifier to execute
- `parameters` - Tool parameters (can contain variable references)
- `outputVariable` - State variable to store the result
- `timeout` - Execution timeout in milliseconds
- `optional` - If true, tool failure won't fail the workflow
- `errorMapping` - Map error types to custom outputs

**Example:**
```javascript
{
  id: 'search-docs',
  type: 'tool',
  name: 'Search Documents',
  config: {
    toolId: 'source_search',
    parameters: {
      query: '$.data.searchQuery',
      limit: 10
    },
    outputVariable: 'searchResults',
    timeout: 30000
  }
}
```

### 5. DecisionNodeExecutor

**Purpose:** Conditional branching based on state data.

**Decision Types:**

#### Expression-based
```javascript
{
  id: 'check-results',
  type: 'decision',
  config: {
    type: 'expression',
    expression: '$.data.results.length > 0'
  }
}
```

#### Switch-based
```javascript
{
  id: 'route-by-type',
  type: 'decision',
  config: {
    type: 'switch',
    variable: '$.data.documentType',
    conditions: [
      { branch: 'pdf', equals: 'application/pdf' },
      { branch: 'image', contains: 'image/' }
    ],
    defaultBranch: 'unknown'
  }
}
```

**Supported Conditions:**
- `equals` - Exact equality
- `notEquals` - Not equal
- `greaterThan`, `lessThan` - Numeric comparison
- `greaterThanOrEqual`, `lessThanOrEqual` - Inclusive comparison
- `contains` - String contains substring
- `matches` - Regex pattern match
- `in`, `notIn` - Array membership

## Variable Resolution

All executors support JSONPath-like variable references:

- `$.data.fieldName` - Access workflow data
- `$.nodeOutputs.nodeId.field` - Access node output
- `$.metadata.field` - Access workflow metadata
- `$.input.field` - Access initial input (in StartNode)

**Template Variables:**
```javascript
// Simple reference
"$.data.userName"

// Template interpolation
"Hello, ${$.data.userName}!"

// In parameters
{
  query: '$.data.searchQuery',
  filters: {
    date: '$.data.dateFilter'
  }
}
```

## Execution Result Format

All executors return a standardized result:

```javascript
{
  status: 'completed' | 'failed' | 'pending',
  output: any,                    // Node output data
  stateUpdates?: object,          // Updates to merge into state.data
  isTerminal?: boolean,           // True for end nodes
  branch?: string,                // For decision nodes
  error?: string                  // Error message if failed
}
```

## Factory Function

Use `getExecutor()` to get executor instances:

```javascript
import { getExecutor } from './executors/index.js';

// Cached instance (default)
const executor = getExecutor('agent');

// Fresh instance with options
const executor = getExecutor('agent', {
  fresh: true,
  maxIterations: 20
});
```

## Extending with Custom Executors

```javascript
import { registerExecutor, BaseNodeExecutor } from './executors/index.js';

class CustomNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    // Custom logic
    return this.createSuccessResult(output, {
      stateUpdates: { customVar: output }
    });
  }
}

registerExecutor('custom', CustomNodeExecutor);
```

## Integration with Existing Services

### ToolExecutor Pattern

The `AgentNodeExecutor` follows the same patterns as the existing `ToolExecutor`:
- Streaming LLM responses
- Tool call loop with max iterations
- Tool result accumulation
- Error handling and recovery

### ChatService Integration

Agents use the same infrastructure:
- `createCompletionRequest()` for LLM requests
- `convertResponseToGeneric()` for response parsing
- `runTool()` for tool execution
- `throttledFetch()` for rate limiting

## Security Considerations

### DecisionNodeExecutor

The expression evaluator includes security measures:
- Blocks dangerous patterns (function, eval, require, etc.)
- No semicolons or braces allowed
- Strict mode evaluation
- Limited to comparison and logical operators

### ToolNodeExecutor

- Tool IDs are validated against configured tools
- Parameters are resolved but not executed as code
- Timeout support to prevent runaway execution

## Testing

Test each executor type:

```javascript
import { getExecutor } from './executors/index.js';

// Test start node
const startExecutor = getExecutor('start');
const result = await startExecutor.execute(
  { id: 'start', type: 'start', config: {} },
  { data: {}, nodeOutputs: {} },
  { initialData: { query: 'test' } }
);

// Test decision node
const decisionExecutor = getExecutor('decision');
const result = await decisionExecutor.execute(
  {
    id: 'check',
    type: 'decision',
    config: {
      type: 'expression',
      expression: '$.data.count > 5'
    }
  },
  { data: { count: 10 }, nodeOutputs: {} },
  {}
);
// result.output.branch === 'true'
```

## Next Steps

1. Create `WorkflowEngine` class that orchestrates execution using these executors
2. Implement `DAGScheduler` for node scheduling
3. Add workflow API routes
4. Create workflow configuration storage in configCache
