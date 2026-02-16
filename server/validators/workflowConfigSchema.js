import { z } from 'zod';
import {
  APP_ID_PATTERN,
  APP_ID_MAX_LENGTH,
  LANGUAGE_CODE_PATTERN
} from '../../shared/validationPatterns.js';

/**
 * Workflow Configuration Schema
 *
 * Defines the validation schema for workflow definitions used in the
 * agentic workflow orchestration system. Workflows consist of nodes
 * connected by edges, forming a directed graph that represents the
 * execution flow of AI agents, tools, and decision points.
 *
 * @module workflowConfigSchema
 */

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Localized string schema - matches client pattern for language codes
 * Allows specifying text in multiple languages (e.g., { "en": "Hello", "de": "Hallo" })
 */
const localizedStringSchema = z.record(
  z
    .string()
    .regex(LANGUAGE_CODE_PATTERN, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

/**
 * Optional localized string schema - same as localizedStringSchema but values can be empty
 * Used for optional descriptive fields where empty strings are acceptable
 */
const optionalLocalizedStringSchema = z.record(
  z
    .string()
    .regex(LANGUAGE_CODE_PATTERN, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string()
);

/**
 * Semver pattern for version validation
 * Matches versions like 1.0.0, 2.1.3, 0.0.1-beta, 1.0.0-alpha.1
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// ============================================================================
// Node Execution Configuration
// ============================================================================

/**
 * Node execution configuration schema
 * Defines timeout, retry behavior, and error handling for individual nodes
 */
const nodeExecutionSchema = z
  .object({
    /** Maximum execution time for this node in milliseconds */
    timeout: z.number().int().min(1000).max(300000).optional().default(30000),
    /** Number of retry attempts on failure (0 = no retries) */
    retries: z.number().int().min(0).max(5).optional().default(0),
    /** Delay between retry attempts in milliseconds */
    retryDelay: z.number().int().min(100).max(60000).optional().default(1000),
    /** How to handle errors at this node */
    errorHandler: z.enum(['fail', 'continue', 'llm_recovery']).optional()
  })
  .optional();

// ============================================================================
// Node Position Schema (for Visual Editor)
// ============================================================================

/**
 * Position schema for visual editor canvas placement
 * Coordinates are in pixels relative to canvas origin
 */
const positionSchema = z.object({
  /** X coordinate on the canvas */
  x: z.number(),
  /** Y coordinate on the canvas */
  y: z.number()
});

// ============================================================================
// Node Configuration Schema
// ============================================================================

/**
 * Workflow node types enumeration
 *
 * - start: Entry point of the workflow (exactly one required)
 * - end: Exit point of the workflow (at least one required)
 * - agent: LLM-powered agent that processes input and produces output
 * - tool: External tool or API integration
 * - decision: Conditional branching based on data or LLM evaluation
 * - parallel: Fork execution into multiple parallel branches
 * - join: Synchronization point for parallel branches
 * - human: Human-in-the-loop interaction point
 * - transform: Data transformation and mapping
 * - memory: Memory read/write operations for context persistence
 */
const nodeTypeEnum = z.enum([
  'start',
  'end',
  'agent',
  'tool',
  'decision',
  'parallel',
  'join',
  'human',
  'transform',
  'memory'
]);

/**
 * Node configuration schema
 * Represents a single node in the workflow graph
 */
export const nodeConfigSchema = z.object({
  /** Unique identifier for this node within the workflow */
  id: z.string().min(1, 'Node ID cannot be empty'),

  /** Type of node determining its behavior */
  type: nodeTypeEnum,

  /** Display name for the node (localized) */
  name: localizedStringSchema,

  /** Optional description of what this node does (localized) */
  description: optionalLocalizedStringSchema.optional(),

  /** Position on the visual editor canvas */
  position: positionSchema,

  /**
   * Type-specific configuration object
   * Structure varies based on node type. Uses passthrough to allow
   * flexible configuration without strict type-specific validation.
   *
   * Examples:
   * - agent: { appId: string, model: string, prompt: string }
   * - tool: { toolId: string, parameters: object }
   * - decision: { conditions: array }
   * - transform: { mappings: object }
   * - memory: { operation: 'read' | 'write', key: string }
   * - human: {
   *     message: LocalizedString,        // Message to display to user
   *     options: Array<{                 // Available response options
   *       value: string,                 // Option value for workflow routing
   *       label: LocalizedString,        // Display label
   *       style?: 'primary' | 'secondary' | 'danger'  // Button style
   *     }>,
   *     inputSchema?: JSONSchema,        // Optional form schema for additional input
   *     showData?: string[],             // JSONPath expressions for data to display
   *     timeout?: number                 // Optional timeout in milliseconds
   *   }
   */
  config: z
    .object({
      /** Whether this node's progress is visible in the chat step indicator. Defaults to true. */
      chatVisible: z.boolean().optional()
    })
    .passthrough()
    .optional(),

  /** Execution configuration for this node */
  execution: nodeExecutionSchema
});

// ============================================================================
// Edge Condition Schema
// ============================================================================

/**
 * Edge condition types
 *
 * - always: Edge is always traversed (default)
 * - never: Edge is never traversed (useful for disabling paths)
 * - expression: Edge is traversed if expression evaluates to true
 * - equals: Edge is traversed if field equals value
 * - contains: Edge is traversed if field contains value
 * - exists: Edge is traversed if field exists and is truthy
 * - llm: Edge is traversed based on LLM evaluation of a prompt
 */
const edgeConditionSchema = z
  .object({
    /** Type of condition evaluation */
    type: z
      .enum(['always', 'never', 'expression', 'equals', 'contains', 'exists', 'llm'])
      .optional()
      .default('always'),

    /**
     * Expression for 'expression' type conditions
     * Example: "result.success === true"
     */
    expression: z.string().optional(),

    /**
     * Field path for 'equals', 'contains', 'exists' type conditions
     * Example: "result.branch" or "data.status"
     */
    field: z.string().optional(),

    /**
     * Value to compare against for 'equals' and 'contains' conditions
     */
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),

    /**
     * Prompt for LLM-based routing decisions
     * The LLM evaluates this prompt and returns true/false
     * Example: "Should this request be escalated to a human agent?"
     */
    llmPrompt: z.string().optional()
  })
  .optional();

// ============================================================================
// Edge Configuration Schema
// ============================================================================

/**
 * Edge configuration schema
 * Represents a connection between two nodes in the workflow graph
 */
export const edgeConfigSchema = z.object({
  /** Unique identifier for this edge */
  id: z.string().min(1, 'Edge ID cannot be empty'),

  /** ID of the source node */
  source: z.string().min(1, 'Source node ID cannot be empty'),

  /** ID of the target node */
  target: z.string().min(1, 'Target node ID cannot be empty'),

  /**
   * Handle identifier on the source node for multi-output nodes
   * Used when a node has multiple output ports (e.g., decision node with yes/no)
   */
  sourceHandle: z.string().optional(),

  /**
   * Handle identifier on the target node for multi-input nodes
   * Used when a node can receive input from multiple sources
   */
  targetHandle: z.string().optional(),

  /** Condition that determines if this edge should be traversed */
  condition: edgeConditionSchema,

  /** Optional label for display on the visual editor (localized) */
  label: optionalLocalizedStringSchema.optional()
});

// ============================================================================
// Workflow Global Configuration Schema
// ============================================================================

/**
 * Workflow-level configuration options
 * Controls observability, persistence, error handling, and resource limits
 */
const workflowGlobalConfigSchema = z
  .object({
    /**
     * Level of observability/logging for workflow execution
     * - minimal: Only errors and completion status
     * - standard: Node transitions and key events
     * - full: Detailed logging including all inputs/outputs
     */
    observability: z.enum(['minimal', 'standard', 'full']).optional().default('standard'),

    /**
     * Data persistence strategy
     * - none: No persistence, workflow state lost on completion
     * - session: Persist within session, cleared on session end
     * - long_term: Persist across sessions for future reference
     */
    persistence: z.enum(['none', 'session', 'long_term']).optional().default('session'),

    /**
     * Default error handling strategy
     * - fail: Stop workflow execution on error
     * - retry: Retry failed node based on execution config
     * - llm_recovery: Use LLM to attempt error recovery
     */
    errorHandling: z.enum(['fail', 'retry', 'llm_recovery']).optional().default('fail'),

    /**
     * Human-in-the-loop configuration
     * - none: Fully automated execution
     * - approval_gates: Human approval at designated nodes
     * - real_time: Real-time human intervention capability
     */
    humanInLoop: z.enum(['none', 'approval_gates', 'real_time']).optional().default('none'),

    /**
     * Maximum total execution time for the workflow in milliseconds
     * Default: 300000 (5 minutes), Maximum: 600000 (10 minutes)
     */
    maxExecutionTime: z.number().int().min(1000).max(600000).optional().default(300000),

    /**
     * Maximum number of nodes allowed in this workflow
     * Default: 20, Maximum: 50
     */
    maxNodes: z.number().int().min(2).max(50).optional().default(20),

    /**
     * Maximum times any single node can be executed (for cycles/loops)
     * Used to prevent infinite loops in workflows with intentional cycles.
     * Default: 10, Maximum: 100
     */
    maxIterations: z.number().int().min(1).max(100).optional().default(10),

    /**
     * Whether to allow cycles/loops in the workflow graph
     * When true (default), workflows can contain intentional cycles for revision loops
     * and iterative patterns. The maxIterations config protects against infinite loops.
     * When false, strict DAG validation is enforced and cycles are rejected at start.
     */
    allowCycles: z.boolean().optional().default(true),

    /**
     * Default model ID for agent nodes that don't specify their own modelId.
     * Avoids repeating the same modelId in every agent node config.
     */
    defaultModelId: z.string().optional()
  })
  .optional();

// ============================================================================
// Canvas Metadata Schema (for Visual Editor)
// ============================================================================

/**
 * Canvas metadata for visual editor state persistence
 * Stores zoom level and viewport offset
 */
const canvasSchema = z
  .object({
    /** Current zoom level (1.0 = 100%) */
    zoom: z.number().min(0.1).max(5).optional(),
    /** Horizontal offset of the viewport in pixels */
    offsetX: z.number().optional(),
    /** Vertical offset of the viewport in pixels */
    offsetY: z.number().optional()
  })
  .optional();

// ============================================================================
// Main Workflow Configuration Schema
// ============================================================================

/**
 * Base workflow configuration schema without refinements
 * Defines the complete structure of a workflow definition
 */
const baseWorkflowConfigSchema = z.object({
  /**
   * Unique identifier for this workflow
   * Must contain only alphanumeric characters, underscores, dots, and hyphens
   */
  id: z
    .string()
    .regex(
      APP_ID_PATTERN,
      'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
    )
    .min(1, 'ID cannot be empty')
    .max(APP_ID_MAX_LENGTH, `ID cannot exceed ${APP_ID_MAX_LENGTH} characters`),

  /** Display name for the workflow (localized) */
  name: localizedStringSchema,

  /** Description of what this workflow does (localized) */
  description: localizedStringSchema,

  /**
   * Semantic version of the workflow definition
   * Format: MAJOR.MINOR.PATCH (e.g., 1.0.0, 2.1.3-beta)
   */
  version: z.string().regex(SEMVER_PATTERN, 'Version must be in semver format (e.g., 1.0.0)'),

  /** Whether this workflow is active and can be executed */
  enabled: z.boolean().optional().default(true),

  /** Global workflow configuration options */
  config: workflowGlobalConfigSchema,

  /**
   * Array of nodes that make up the workflow graph
   * Must contain at least 2 nodes (one start and one end)
   */
  nodes: z.array(nodeConfigSchema).min(2, 'Workflow must have at least 2 nodes (start and end)'),

  /** Array of edges connecting the nodes */
  edges: z.array(edgeConfigSchema),

  /**
   * Source IDs to load and make available to agent nodes.
   * Sources are resolved from the admin source configuration (sources.json).
   * Agent nodes can reference source content via {{sources}} in their prompts.
   */
  sources: z.array(z.string()).optional(),

  /**
   * Groups that are allowed to execute this workflow
   * If not specified, workflow visibility follows default platform permissions
   */
  allowedGroups: z.array(z.string()).optional(),

  /**
   * Chat integration configuration
   * Controls how this workflow appears and behaves when used as a tool from chat
   */
  chatIntegration: z
    .object({
      /** Whether the workflow appears as a selectable tool in chat apps */
      enabled: z.boolean().optional().default(false),
      /** If true, workflow output streams directly as chat answer; if false, LLM formats the result */
      passthroughResult: z.boolean().optional().default(false),
      /** Overrides workflow description for the LLM tool definition */
      toolDescription: localizedStringSchema.optional(),
      /** Which output field to display as the primary result (e.g., "finalReport") */
      primaryOutput: z.string().optional(),
      /** Output format hint for the client renderer */
      outputFormat: z.enum(['markdown', 'text', 'json']).optional()
    })
    .optional(),

  /** Visual editor canvas state */
  canvas: canvasSchema
});

// Export known workflow keys from base schema before adding refinements
export const knownWorkflowKeys = Object.keys(baseWorkflowConfigSchema.shape);

// ============================================================================
// Schema Refinements
// ============================================================================

/**
 * Complete workflow configuration schema with validation refinements
 *
 * Refinements ensure:
 * 1. Exactly one 'start' node exists
 * 2. At least one 'end' node exists
 * 3. All edge source/target references are valid node IDs
 * 4. No orphan nodes (every node except start must have an incoming edge)
 */
export const workflowConfigSchema = baseWorkflowConfigSchema
  .strict()
  .refine(
    data => {
      // Count start nodes - must be exactly one
      const startNodes = data.nodes.filter(node => node.type === 'start');
      return startNodes.length === 1;
    },
    {
      message: 'Workflow must have exactly one start node',
      path: ['nodes']
    }
  )
  .refine(
    data => {
      // Count end nodes - must be at least one
      const endNodes = data.nodes.filter(node => node.type === 'end');
      return endNodes.length >= 1;
    },
    {
      message: 'Workflow must have at least one end node',
      path: ['nodes']
    }
  )
  .refine(
    data => {
      // Validate all edge source references point to existing nodes
      const nodeIds = new Set(data.nodes.map(node => node.id));
      return data.edges.every(edge => nodeIds.has(edge.source));
    },
    {
      message: 'All edge source references must point to valid node IDs',
      path: ['edges']
    }
  )
  .refine(
    data => {
      // Validate all edge target references point to existing nodes
      const nodeIds = new Set(data.nodes.map(node => node.id));
      return data.edges.every(edge => nodeIds.has(edge.target));
    },
    {
      message: 'All edge target references must point to valid node IDs',
      path: ['edges']
    }
  )
  .refine(
    data => {
      // Check for orphan nodes - every node except start must have an incoming edge
      const nodeIds = new Set(data.nodes.map(node => node.id));
      const nodesWithIncomingEdges = new Set(data.edges.map(edge => edge.target));
      const startNodes = data.nodes.filter(node => node.type === 'start').map(node => node.id);

      // All non-start nodes must have at least one incoming edge
      for (const nodeId of nodeIds) {
        if (!startNodes.includes(nodeId) && !nodesWithIncomingEdges.has(nodeId)) {
          return false;
        }
      }
      return true;
    },
    {
      message: 'All nodes except the start node must have at least one incoming edge',
      path: ['nodes']
    }
  );
