/**
 * Iterative Research Workflow Tests
 *
 * Tests for multi-iteration workflow structure and LLM integration.
 *
 * NOTE: Structure tests run with Jest. Integration tests with real LLM
 * require the workflow engine and should be run with the standalone test runner.
 */

import { simpleAgentWorkflow, iterativeResearchWorkflow } from './fixtures/mock-workflows.js';
import { skipIfNoApiKey, getSkipReason } from './fixtures/workflow-test-utils.js';

describe('Iterative Research Workflow - Structure Tests', () => {
  describe('simpleAgentWorkflow', () => {
    test('has correct structure', () => {
      expect(simpleAgentWorkflow.id).toBe('test-simple-agent');
      expect(simpleAgentWorkflow.config.maxIterations).toBe(5);
      expect(simpleAgentWorkflow.config.allowCycles).toBe(false);
    });

    test('has agent node with proper config', () => {
      const agentNode = simpleAgentWorkflow.nodes.find(n => n.type === 'agent');
      expect(agentNode).toBeDefined();
      expect(agentNode.id).toBe('summarize');
      expect(agentNode.config.system).toBeDefined();
      expect(agentNode.config.system.en).toContain('helpful assistant');
      expect(agentNode.config.prompt).toBeDefined();
      expect(agentNode.config.prompt.en).toContain('Summarize');
      expect(agentNode.config.modelId).toBe('gemini-3.0-flash');
      expect(agentNode.config.outputVariable).toBe('summary');
    });

    test('has start node with text input', () => {
      const startNode = simpleAgentWorkflow.nodes.find(n => n.type === 'start');
      expect(startNode).toBeDefined();
      expect(startNode.config.inputVariables).toHaveLength(1);
      expect(startNode.config.inputVariables[0].name).toBe('text');
      expect(startNode.config.inputVariables[0].type).toBe('string');
    });

    test('has end node with summary output', () => {
      const endNode = simpleAgentWorkflow.nodes.find(n => n.type === 'end');
      expect(endNode).toBeDefined();
      expect(endNode.config.outputVariables).toContain('summary');
    });

    test('has linear flow from start to end', () => {
      const edges = simpleAgentWorkflow.edges;
      expect(edges).toHaveLength(2);

      expect(edges[0].source).toBe('start');
      expect(edges[0].target).toBe('summarize');
      expect(edges[1].source).toBe('summarize');
      expect(edges[1].target).toBe('end');
    });
  });

  describe('iterativeResearchWorkflow', () => {
    test('has correct structure', () => {
      expect(iterativeResearchWorkflow.id).toBe('test-iterative-research');
      expect(iterativeResearchWorkflow.config.maxIterations).toBe(10);
      expect(iterativeResearchWorkflow.config.allowCycles).toBe(true);
    });

    test('has initialization transform node', () => {
      const initNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'init');
      expect(initNode).toBeDefined();
      expect(initNode.type).toBe('transform');

      const operations = initNode.config.operations;
      expect(operations).toHaveLength(3);

      // Check each initialization operation
      const findingsOp = operations.find(op => op.set === 'findings');
      expect(findingsOp.value).toEqual([]);

      const iterationOp = operations.find(op => op.set === 'iteration');
      expect(iterationOp.value).toBe(0);

      const maxIterationsOp = operations.find(op => op.set === 'maxIterations');
      expect(maxIterationsOp.value).toBe(2);
    });

    test('has research agent node', () => {
      const researchNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'research');
      expect(researchNode).toBeDefined();
      expect(researchNode.type).toBe('agent');
      expect(researchNode.config.outputVariable).toBe('currentFinding');
      expect(researchNode.config.outputSchema).toBeDefined();
      expect(researchNode.config.outputSchema.properties.finding).toBeDefined();
    });

    test('has accumulate transform node', () => {
      const accumulateNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'accumulate');
      expect(accumulateNode).toBeDefined();
      expect(accumulateNode.type).toBe('transform');

      const operations = accumulateNode.config.operations;
      expect(operations).toHaveLength(2);

      // Check push operation
      const pushOp = operations.find(op => op.push);
      expect(pushOp.push).toBe('currentFinding');
      expect(pushOp.to).toBe('findings');

      // Check increment operation
      const incrementOp = operations.find(op => op.increment);
      expect(incrementOp.increment).toBe('iteration');
      expect(incrementOp.by).toBe(1);
    });

    test('has decision node for loop control', () => {
      const checkNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'check-complete');
      expect(checkNode).toBeDefined();
      expect(checkNode.type).toBe('decision');
      expect(checkNode.config.type).toBe('expression');
      expect(checkNode.config.expression).toBe('$.data.iteration >= $.data.maxIterations');
    });

    test('has loop edge back to research node', () => {
      const loopEdge = iterativeResearchWorkflow.edges.find(
        e => e.source === 'check-complete' && e.target === 'research'
      );
      expect(loopEdge).toBeDefined();
      expect(loopEdge.condition.field).toBe('result.branch');
      expect(loopEdge.condition.value).toBe('false');
    });

    test('has exit edge to end node', () => {
      const exitEdge = iterativeResearchWorkflow.edges.find(
        e => e.source === 'check-complete' && e.target === 'end'
      );
      expect(exitEdge).toBeDefined();
      expect(exitEdge.condition.field).toBe('result.branch');
      expect(exitEdge.condition.value).toBe('true');
    });

    test('end node outputs findings and iteration', () => {
      const endNode = iterativeResearchWorkflow.nodes.find(n => n.type === 'end');
      expect(endNode).toBeDefined();
      expect(endNode.config.outputVariables).toContain('findings');
      expect(endNode.config.outputVariables).toContain('iteration');
      expect(endNode.config.outputVariables).toContain('topic');
    });
  });
});

describe('LLM API Configuration Check', () => {
  test('reports correct API key status', () => {
    const shouldSkip = skipIfNoApiKey();
    const reason = getSkipReason();

    // This test just verifies the skip detection works
    if (shouldSkip) {
      expect(reason).toContain('No LLM API key');
      console.log('LLM tests would be skipped:', reason);
    } else {
      expect(reason).toBe('');
      console.log('LLM API key is configured, integration tests can run');
    }
  });
});

describe('Workflow Template Variables', () => {
  test('research prompt uses template variables', () => {
    const researchNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'research');
    const prompt = researchNode.config.prompt.en;

    expect(prompt).toContain('{{topic}}');
    expect(prompt).toContain('{{iteration}}');
    expect(prompt).toContain('{{findings}}');
  });

  test('summarize prompt uses template variable', () => {
    const summarizeNode = simpleAgentWorkflow.nodes.find(n => n.id === 'summarize');
    const prompt = summarizeNode.config.prompt.en;

    expect(prompt).toContain('{{text}}');
  });
});

describe('Output Schema Validation', () => {
  test('research node has valid output schema', () => {
    const researchNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'research');
    const schema = researchNode.config.outputSchema;

    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.finding).toBeDefined();
    expect(schema.properties.finding.type).toBe('string');
  });
});

describe('Workflow Execution Path Analysis', () => {
  test('iterative workflow has correct node sequence', () => {
    const edges = iterativeResearchWorkflow.edges;

    // Verify the main path: start -> init -> research -> accumulate -> check-complete
    const mainPath = [
      { from: 'start', to: 'init' },
      { from: 'init', to: 'research' },
      { from: 'research', to: 'accumulate' },
      { from: 'accumulate', to: 'check-complete' }
    ];

    mainPath.forEach(({ from, to }) => {
      const edge = edges.find(e => e.source === from && e.target === to);
      expect(edge).toBeDefined();
    });
  });

  test('loop can execute multiple times', () => {
    // The workflow is configured with maxIterations = 10 in config
    // But the init node sets maxIterations = 2 for testing
    const initNode = iterativeResearchWorkflow.nodes.find(n => n.id === 'init');
    const testMaxIterations = initNode.config.operations.find(
      op => op.set === 'maxIterations'
    ).value;

    expect(testMaxIterations).toBe(2);

    // The global config allows more iterations for safety
    expect(iterativeResearchWorkflow.config.maxIterations).toBeGreaterThanOrEqual(
      testMaxIterations
    );
  });
});
