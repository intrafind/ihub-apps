/**
 * Basic Workflow Execution Tests
 *
 * These tests verify core workflow engine functionality with simple workflows.
 *
 * NOTE: Due to Jest ESM compatibility issues with the server code, these tests
 * are split into two categories:
 * 1. Structure tests - validate workflow definitions (always run)
 * 2. Integration tests - require the full workflow engine (run with node directly)
 *
 * To run integration tests, use: node --experimental-vm-modules tests/integration/workflows/run-workflow-tests.js
 */

import {
  simpleLinearWorkflow,
  decisionWorkflow,
  multiTransformWorkflow
} from './fixtures/mock-workflows.js';
import { WorkflowStatus } from './fixtures/workflow-test-utils.js';

describe('Workflow Execution - Structure Tests', () => {
  describe('Simple Linear Workflow', () => {
    test('has correct structure', () => {
      expect(simpleLinearWorkflow.id).toBe('test-simple-linear');
      expect(simpleLinearWorkflow.config.maxIterations).toBe(5);
      expect(simpleLinearWorkflow.config.allowCycles).toBe(false);
    });

    test('has all required nodes', () => {
      const nodeIds = simpleLinearWorkflow.nodes.map(n => n.id);
      expect(nodeIds).toContain('start');
      expect(nodeIds).toContain('transform1');
      expect(nodeIds).toContain('end');
    });

    test('has start node with input variables', () => {
      const startNode = simpleLinearWorkflow.nodes.find(n => n.type === 'start');
      expect(startNode).toBeDefined();
      expect(startNode.config.inputVariables).toHaveLength(1);
      expect(startNode.config.inputVariables[0].name).toBe('input');
    });

    test('has transform node with operations', () => {
      const transformNode = simpleLinearWorkflow.nodes.find(n => n.type === 'transform');
      expect(transformNode).toBeDefined();
      expect(transformNode.config.operations).toBeDefined();
      expect(transformNode.config.operations).toHaveLength(1);
      expect(transformNode.config.operations[0].set).toBe('result');
    });

    test('has end node with output variables', () => {
      const endNode = simpleLinearWorkflow.nodes.find(n => n.type === 'end');
      expect(endNode).toBeDefined();
      expect(endNode.config.outputVariables).toContain('result');
    });

    test('has correct edges connecting nodes', () => {
      const edges = simpleLinearWorkflow.edges;
      expect(edges).toHaveLength(2);

      const startToTransform = edges.find(e => e.source === 'start' && e.target === 'transform1');
      const transformToEnd = edges.find(e => e.source === 'transform1' && e.target === 'end');

      expect(startToTransform).toBeDefined();
      expect(transformToEnd).toBeDefined();
    });
  });

  describe('Decision Workflow', () => {
    test('has correct structure', () => {
      expect(decisionWorkflow.id).toBe('test-decision');
      expect(decisionWorkflow.config.allowCycles).toBe(false);
    });

    test('has decision node with expression', () => {
      const decisionNode = decisionWorkflow.nodes.find(n => n.type === 'decision');
      expect(decisionNode).toBeDefined();
      expect(decisionNode.id).toBe('check');
      expect(decisionNode.config.type).toBe('expression');
      expect(decisionNode.config.expression).toBe('$.data.value > 10');
    });

    test('has branching edges from decision node', () => {
      const edges = decisionWorkflow.edges;

      const trueEdge = edges.find(e => e.source === 'check' && e.condition?.value === 'true');
      const falseEdge = edges.find(e => e.source === 'check' && e.condition?.value === 'false');

      expect(trueEdge).toBeDefined();
      expect(trueEdge.target).toBe('high');

      expect(falseEdge).toBeDefined();
      expect(falseEdge.target).toBe('low');
    });

    test('both branches converge to end node', () => {
      const edges = decisionWorkflow.edges;

      const highToEnd = edges.find(e => e.source === 'high' && e.target === 'end');
      const lowToEnd = edges.find(e => e.source === 'low' && e.target === 'end');

      expect(highToEnd).toBeDefined();
      expect(lowToEnd).toBeDefined();
    });
  });

  describe('Multi-Transform Workflow', () => {
    test('has correct structure', () => {
      expect(multiTransformWorkflow.id).toBe('test-multi-transform');
      expect(multiTransformWorkflow.nodes.length).toBe(5);
    });

    test('has multiple transform nodes', () => {
      const transformNodes = multiTransformWorkflow.nodes.filter(n => n.type === 'transform');
      expect(transformNodes).toHaveLength(3);
    });

    test('transform nodes have different operations', () => {
      const transform1 = multiTransformWorkflow.nodes.find(n => n.id === 'transform1');
      const transform2 = multiTransformWorkflow.nodes.find(n => n.id === 'transform2');
      const transform3 = multiTransformWorkflow.nodes.find(n => n.id === 'transform3');

      // transform1 has 'set' operation
      expect(transform1.config.operations[0].set).toBe('counter');

      // transform2 has 'increment' and 'lengthOf' operations
      expect(transform2.config.operations[0].increment).toBe('counter');
      expect(transform2.config.operations[1].lengthOf).toBe('items');

      // transform3 has 'arrayGet' and 'set' operations
      expect(transform3.config.operations[0].arrayGet).toBe('items');
      expect(transform3.config.operations[1].set).toBe('processed');
    });

    test('has sequential edges', () => {
      const edges = multiTransformWorkflow.edges;

      // Verify linear flow
      const sequence = [
        { source: 'start', target: 'transform1' },
        { source: 'transform1', target: 'transform2' },
        { source: 'transform2', target: 'transform3' },
        { source: 'transform3', target: 'end' }
      ];

      sequence.forEach(({ source, target }) => {
        const edge = edges.find(e => e.source === source && e.target === target);
        expect(edge).toBeDefined();
      });
    });
  });
});

describe('Workflow Status Constants', () => {
  test('WorkflowStatus has expected values', () => {
    expect(WorkflowStatus.PENDING).toBe('pending');
    expect(WorkflowStatus.RUNNING).toBe('running');
    expect(WorkflowStatus.PAUSED).toBe('paused');
    expect(WorkflowStatus.COMPLETED).toBe('completed');
    expect(WorkflowStatus.FAILED).toBe('failed');
    expect(WorkflowStatus.CANCELLED).toBe('cancelled');
  });
});

describe('Workflow Validation', () => {
  test('all workflows have unique node IDs', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const nodeIds = workflow.nodes.map(n => n.id);
      const uniqueIds = [...new Set(nodeIds)];
      expect(nodeIds.length).toBe(uniqueIds.length);
    });
  });

  test('all workflows have unique edge IDs', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const edgeIds = workflow.edges.map(e => e.id);
      const uniqueIds = [...new Set(edgeIds)];
      expect(edgeIds.length).toBe(uniqueIds.length);
    });
  });

  test('all edge sources reference existing nodes', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const nodeIds = new Set(workflow.nodes.map(n => n.id));
      workflow.edges.forEach(edge => {
        expect(nodeIds.has(edge.source)).toBe(true);
      });
    });
  });

  test('all edge targets reference existing nodes', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const nodeIds = new Set(workflow.nodes.map(n => n.id));
      workflow.edges.forEach(edge => {
        expect(nodeIds.has(edge.target)).toBe(true);
      });
    });
  });

  test('all workflows have exactly one start node', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const startNodes = workflow.nodes.filter(n => n.type === 'start');
      expect(startNodes).toHaveLength(1);
    });
  });

  test('all workflows have at least one end node', () => {
    [simpleLinearWorkflow, decisionWorkflow, multiTransformWorkflow].forEach(workflow => {
      const endNodes = workflow.nodes.filter(n => n.type === 'end');
      expect(endNodes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
