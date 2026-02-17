/**
 * Human Checkpoint Workflow Tests
 *
 * Tests for workflows with human nodes using automated responses.
 *
 * NOTE: Structure tests run with Jest. Integration tests with the workflow engine
 * should be run with the standalone test runner.
 */

import { humanCheckpointWorkflow } from './fixtures/mock-workflows.js';
import { WorkflowStatus } from './fixtures/workflow-test-utils.js';

describe('Human Checkpoint Workflow - Structure Tests', () => {
  describe('humanCheckpointWorkflow', () => {
    test('has correct structure', () => {
      expect(humanCheckpointWorkflow.id).toBe('test-human-checkpoint');
      expect(humanCheckpointWorkflow.config.maxIterations).toBe(5);
      expect(humanCheckpointWorkflow.config.allowCycles).toBe(true);
    });

    test('has start node with content input', () => {
      const startNode = humanCheckpointWorkflow.nodes.find(n => n.type === 'start');
      expect(startNode).toBeDefined();
      expect(startNode.config.inputVariables).toHaveLength(1);
      expect(startNode.config.inputVariables[0].name).toBe('content');
      expect(startNode.config.inputVariables[0].type).toBe('string');
    });

    test('has human node', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.type === 'human');
      expect(humanNode).toBeDefined();
      expect(humanNode.id).toBe('approval');
    });

    test('human node has message', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
      expect(humanNode.config.message).toBeDefined();
      expect(humanNode.config.message.en).toBeDefined();
      expect(humanNode.config.message.en).toContain('{{content}}');
    });

    test('human node has three options', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
      expect(humanNode.config.options).toBeDefined();
      expect(humanNode.config.options).toHaveLength(3);

      const optionValues = humanNode.config.options.map(o => o.value);
      expect(optionValues).toContain('approve');
      expect(optionValues).toContain('reject');
      expect(optionValues).toContain('revise');
    });

    test('human node options have styles', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');

      const approveOption = humanNode.config.options.find(o => o.value === 'approve');
      const rejectOption = humanNode.config.options.find(o => o.value === 'reject');
      const reviseOption = humanNode.config.options.find(o => o.value === 'revise');

      expect(approveOption.style).toBe('primary');
      expect(rejectOption.style).toBe('danger');
      expect(reviseOption.style).toBe('secondary');
    });

    test('human node has input schema for feedback', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
      expect(humanNode.config.inputSchema).toBeDefined();
      expect(humanNode.config.inputSchema.type).toBe('object');
      expect(humanNode.config.inputSchema.properties.feedback).toBeDefined();
      expect(humanNode.config.inputSchema.properties.feedback.type).toBe('string');
    });

    test('human node has showData configuration', () => {
      const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
      expect(humanNode.config.showData).toBeDefined();
      expect(humanNode.config.showData).toContain('$.data.content');
    });

    test('has approved and rejected transform nodes', () => {
      const approvedNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approved');
      const rejectedNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'rejected');

      expect(approvedNode).toBeDefined();
      expect(approvedNode.type).toBe('transform');
      expect(approvedNode.config.operations[0].set).toBe('status');
      expect(approvedNode.config.operations[0].value).toBe('approved');

      expect(rejectedNode).toBeDefined();
      expect(rejectedNode.type).toBe('transform');
      expect(rejectedNode.config.operations[0].set).toBe('status');
      expect(rejectedNode.config.operations[0].value).toBe('rejected');
    });

    test('has end node with status output', () => {
      const endNode = humanCheckpointWorkflow.nodes.find(n => n.type === 'end');
      expect(endNode).toBeDefined();
      expect(endNode.config.outputVariables).toContain('status');
      expect(endNode.config.outputVariables).toContain('content');
    });
  });

  describe('Branching from Human Node', () => {
    test('has edge from approval to approved (approve branch)', () => {
      const edge = humanCheckpointWorkflow.edges.find(
        e => e.source === 'approval' && e.target === 'approved'
      );
      expect(edge).toBeDefined();
      expect(edge.condition.type).toBe('equals');
      expect(edge.condition.field).toBe('result.branch');
      expect(edge.condition.value).toBe('approve');
    });

    test('has edge from approval to rejected (reject branch)', () => {
      const edge = humanCheckpointWorkflow.edges.find(
        e => e.source === 'approval' && e.target === 'rejected'
      );
      expect(edge).toBeDefined();
      expect(edge.condition.type).toBe('equals');
      expect(edge.condition.field).toBe('result.branch');
      expect(edge.condition.value).toBe('reject');
    });

    test('has edge from approval to start (revise branch)', () => {
      const edge = humanCheckpointWorkflow.edges.find(
        e => e.source === 'approval' && e.target === 'start'
      );
      expect(edge).toBeDefined();
      expect(edge.condition.type).toBe('equals');
      expect(edge.condition.field).toBe('result.branch');
      expect(edge.condition.value).toBe('revise');
    });

    test('both result branches converge to end node', () => {
      const approvedToEnd = humanCheckpointWorkflow.edges.find(
        e => e.source === 'approved' && e.target === 'end'
      );
      const rejectedToEnd = humanCheckpointWorkflow.edges.find(
        e => e.source === 'rejected' && e.target === 'end'
      );

      expect(approvedToEnd).toBeDefined();
      expect(rejectedToEnd).toBeDefined();
    });
  });

  describe('Loop Path (Revise)', () => {
    test('revise creates a cycle back to start', () => {
      const reviseEdge = humanCheckpointWorkflow.edges.find(
        e => e.source === 'approval' && e.target === 'start'
      );
      expect(reviseEdge).toBeDefined();
    });

    test('allowCycles is enabled for revision workflow', () => {
      expect(humanCheckpointWorkflow.config.allowCycles).toBe(true);
    });
  });
});

describe('Workflow Status Constants for Human Nodes', () => {
  test('PAUSED status is defined for human checkpoints', () => {
    expect(WorkflowStatus.PAUSED).toBe('paused');
  });
});

describe('Human Node Configuration Validation', () => {
  test('all options have labels', () => {
    const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');

    humanNode.config.options.forEach(option => {
      expect(option.label).toBeDefined();
      expect(option.label.en).toBeDefined();
      expect(option.label.en.length).toBeGreaterThan(0);
    });
  });

  test('all options have unique values', () => {
    const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
    const values = humanNode.config.options.map(o => o.value);
    const uniqueValues = [...new Set(values)];

    expect(values.length).toBe(uniqueValues.length);
  });

  test('options values match edge conditions', () => {
    const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
    const optionValues = new Set(humanNode.config.options.map(o => o.value));

    // Get all edges from the human node
    const humanEdges = humanCheckpointWorkflow.edges.filter(e => e.source === 'approval');

    // Each edge condition should reference a valid option value
    humanEdges.forEach(edge => {
      expect(optionValues.has(edge.condition.value)).toBe(true);
    });
  });
});

describe('Node Connections', () => {
  test('start node connects to human node', () => {
    const edge = humanCheckpointWorkflow.edges.find(
      e => e.source === 'start' && e.target === 'approval'
    );
    expect(edge).toBeDefined();
  });

  test('human node has outgoing edges for all options', () => {
    const humanNode = humanCheckpointWorkflow.nodes.find(n => n.id === 'approval');
    const optionCount = humanNode.config.options.length;
    const outgoingEdges = humanCheckpointWorkflow.edges.filter(e => e.source === 'approval');

    expect(outgoingEdges.length).toBe(optionCount);
  });
});

describe('Edge Cases', () => {
  test('workflow has no unreachable nodes', () => {
    const nodes = humanCheckpointWorkflow.nodes;
    const edges = humanCheckpointWorkflow.edges;

    // Build a set of all reachable nodes starting from start
    const reachable = new Set();
    const queue = ['start'];

    while (queue.length > 0) {
      const current = queue.shift();
      if (reachable.has(current)) continue;
      reachable.add(current);

      // Find all outgoing edges and add targets to queue
      edges.filter(e => e.source === current).forEach(e => queue.push(e.target));
    }

    // All nodes should be reachable from start
    nodes.forEach(node => {
      expect(reachable.has(node.id)).toBe(true);
    });
  });

  test('all conditional edges have valid condition structure', () => {
    const edges = humanCheckpointWorkflow.edges;

    edges
      .filter(e => e.condition)
      .forEach(edge => {
        expect(edge.condition.type).toBeDefined();
        expect(edge.condition.field).toBeDefined();
        expect(edge.condition.value).toBeDefined();
      });
  });
});
