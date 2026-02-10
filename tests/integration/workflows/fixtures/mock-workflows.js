/**
 * Test workflow definitions for workflow E2E tests.
 *
 * These are simplified workflow definitions used for testing
 * various workflow engine capabilities.
 */

/**
 * Simple linear workflow with transform node.
 * Used for basic execution tests.
 */
export const simpleLinearWorkflow = {
  id: 'test-simple-linear',
  name: { en: 'Simple Linear Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'input', type: 'string', required: true }]
      }
    },
    {
      id: 'transform1',
      type: 'transform',
      name: { en: 'Process Input' },
      config: {
        operations: [{ set: 'result', value: 'processed: {{input}}' }]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['result']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'transform1' },
    { id: 'e2', source: 'transform1', target: 'end' }
  ]
};

/**
 * Workflow with decision node for branching tests.
 */
export const decisionWorkflow = {
  id: 'test-decision',
  name: { en: 'Decision Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'value', type: 'number', required: true }]
      }
    },
    {
      id: 'check',
      type: 'decision',
      name: { en: 'Check Value' },
      config: {
        type: 'expression',
        expression: '$.data.value > 10'
      }
    },
    {
      id: 'high',
      type: 'transform',
      name: { en: 'High Value' },
      config: {
        operations: [{ set: 'result', value: 'high' }]
      }
    },
    {
      id: 'low',
      type: 'transform',
      name: { en: 'Low Value' },
      config: {
        operations: [{ set: 'result', value: 'low' }]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['result', 'value']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'check' },
    {
      id: 'e2',
      source: 'check',
      target: 'high',
      condition: { type: 'equals', field: 'result.branch', value: 'true' }
    },
    {
      id: 'e3',
      source: 'check',
      target: 'low',
      condition: { type: 'equals', field: 'result.branch', value: 'false' }
    },
    { id: 'e4', source: 'high', target: 'end' },
    { id: 'e5', source: 'low', target: 'end' }
  ]
};

/**
 * Workflow with human checkpoint node.
 */
export const humanCheckpointWorkflow = {
  id: 'test-human-checkpoint',
  name: { en: 'Human Checkpoint Test' },
  config: { maxIterations: 5, allowCycles: true },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'content', type: 'string', required: true }]
      }
    },
    {
      id: 'approval',
      type: 'human',
      name: { en: 'Request Approval' },
      config: {
        message: { en: 'Please review and approve the content: {{content}}' },
        options: [
          { value: 'approve', label: { en: 'Approve' }, style: 'primary' },
          { value: 'reject', label: { en: 'Reject' }, style: 'danger' },
          { value: 'revise', label: { en: 'Revise' }, style: 'secondary' }
        ],
        inputSchema: {
          type: 'object',
          properties: {
            feedback: { type: 'string', title: 'Feedback' }
          }
        },
        showData: ['$.data.content']
      }
    },
    {
      id: 'approved',
      type: 'transform',
      name: { en: 'Approved' },
      config: {
        operations: [{ set: 'status', value: 'approved' }]
      }
    },
    {
      id: 'rejected',
      type: 'transform',
      name: { en: 'Rejected' },
      config: {
        operations: [{ set: 'status', value: 'rejected' }]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['status', 'content']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'approval' },
    {
      id: 'e2',
      source: 'approval',
      target: 'approved',
      condition: { type: 'equals', field: 'result.branch', value: 'approve' }
    },
    {
      id: 'e3',
      source: 'approval',
      target: 'rejected',
      condition: { type: 'equals', field: 'result.branch', value: 'reject' }
    },
    {
      id: 'e4',
      source: 'approval',
      target: 'start',
      condition: { type: 'equals', field: 'result.branch', value: 'revise' }
    },
    { id: 'e5', source: 'approved', target: 'end' },
    { id: 'e6', source: 'rejected', target: 'end' }
  ]
};

/**
 * Simple agent workflow for LLM integration tests.
 * Uses a simple summarization task without tools.
 */
export const simpleAgentWorkflow = {
  id: 'test-simple-agent',
  name: { en: 'Simple Agent Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'text', type: 'string', required: true }]
      }
    },
    {
      id: 'summarize',
      type: 'agent',
      name: { en: 'Summarize' },
      config: {
        system: { en: 'You are a helpful assistant. Be concise.' },
        prompt: { en: 'Summarize the following text in one sentence: {{text}}' },
        model: 'auto',
        outputVariable: 'summary'
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['summary']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'summarize' },
    { id: 'e2', source: 'summarize', target: 'end' }
  ]
};

/**
 * Agent workflow with tool usage for testing tool calling.
 */
export const toolCallingWorkflow = {
  id: 'test-tool-calling',
  name: { en: 'Tool Calling Test' },
  config: { maxIterations: 10, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'query', type: 'string', required: true }]
      }
    },
    {
      id: 'searcher',
      type: 'agent',
      name: { en: 'Search Agent' },
      config: {
        system: {
          en: 'You are a research assistant. Use the provided tools to search for information and provide a summary.'
        },
        prompt: {
          en: 'Search for information about: {{query}}. Use the googleSearch tool, then summarize what you found in 2-3 sentences.'
        },
        model: 'auto',
        tools: ['googleSearch'],
        maxIterations: 3,
        outputVariable: 'searchResults',
        outputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['searchResults']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'searcher' },
    { id: 'e2', source: 'searcher', target: 'end' }
  ]
};

/**
 * Simplified iterative research workflow for testing loops.
 * Limited to 2 iterations for faster testing.
 */
export const iterativeResearchWorkflow = {
  id: 'test-iterative-research',
  name: { en: 'Iterative Research Test' },
  config: { maxIterations: 10, allowCycles: true },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'topic', type: 'string', required: true }]
      }
    },
    {
      id: 'init',
      type: 'transform',
      name: { en: 'Initialize' },
      config: {
        operations: [
          { set: 'findings', value: [] },
          { set: 'iteration', value: 0 },
          { set: 'maxIterations', value: 2 }
        ]
      }
    },
    {
      id: 'research',
      type: 'agent',
      name: { en: 'Research' },
      config: {
        system: {
          en: 'You are a research assistant. Provide exactly one new finding about the topic.'
        },
        prompt: {
          en: 'Research topic: {{topic}}\nIteration: {{iteration}}\nPrevious findings: {{findings}}\n\nProvide one new key finding about this topic that was not mentioned in previous findings. Output as JSON with a "finding" field.'
        },
        model: 'auto',
        outputVariable: 'currentFinding',
        outputSchema: {
          type: 'object',
          properties: {
            finding: { type: 'string' }
          }
        }
      }
    },
    {
      id: 'accumulate',
      type: 'transform',
      name: { en: 'Accumulate Findings' },
      config: {
        operations: [
          { push: 'currentFinding', to: 'findings' },
          { increment: 'iteration', by: 1 }
        ]
      }
    },
    {
      id: 'check-complete',
      type: 'decision',
      name: { en: 'Check Complete' },
      config: {
        type: 'expression',
        expression: '$.data.iteration >= $.data.maxIterations'
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['findings', 'iteration', 'topic']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'init' },
    { id: 'e2', source: 'init', target: 'research' },
    { id: 'e3', source: 'research', target: 'accumulate' },
    { id: 'e4', source: 'accumulate', target: 'check-complete' },
    {
      id: 'e5',
      source: 'check-complete',
      target: 'end',
      condition: { type: 'equals', field: 'result.branch', value: 'true' }
    },
    {
      id: 'e6',
      source: 'check-complete',
      target: 'research',
      condition: { type: 'equals', field: 'result.branch', value: 'false' }
    }
  ]
};

/**
 * Workflow that is expected to fail (for error handling tests).
 */
export const failingWorkflow = {
  id: 'test-failing',
  name: { en: 'Failing Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {}
    },
    {
      id: 'agent',
      type: 'agent',
      name: { en: 'Failing Agent' },
      config: {
        system: { en: 'You are a test agent.' },
        prompt: { en: 'Hello' },
        modelId: 'non-existent-model-xxx'
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {}
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'agent' },
    { id: 'e2', source: 'agent', target: 'end' }
  ]
};

/**
 * Multi-transform workflow for testing state manipulation.
 */
export const multiTransformWorkflow = {
  id: 'test-multi-transform',
  name: { en: 'Multi-Transform Test' },
  config: { maxIterations: 5, allowCycles: false },
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      config: {
        inputVariables: [{ name: 'items', type: 'array', required: true }]
      }
    },
    {
      id: 'transform1',
      type: 'transform',
      name: { en: 'Initialize Counter' },
      config: {
        operations: [{ set: 'counter', value: 0 }]
      }
    },
    {
      id: 'transform2',
      type: 'transform',
      name: { en: 'Increment and Copy' },
      config: {
        operations: [
          { increment: 'counter', by: 5 },
          { lengthOf: 'items', to: 'itemCount' }
        ]
      }
    },
    {
      id: 'transform3',
      type: 'transform',
      name: { en: 'Array Operation' },
      config: {
        operations: [
          { arrayGet: 'items', index: 0, to: 'firstItem' },
          { set: 'processed', value: true }
        ]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      config: {
        outputVariables: ['counter', 'itemCount', 'firstItem', 'processed']
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'transform1' },
    { id: 'e2', source: 'transform1', target: 'transform2' },
    { id: 'e3', source: 'transform2', target: 'transform3' },
    { id: 'e4', source: 'transform3', target: 'end' }
  ]
};
