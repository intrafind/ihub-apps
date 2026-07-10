/**
 * Workflow API Routes
 *
 * Provides RESTful endpoints for managing and executing agentic workflows.
 * Includes support for workflow CRUD operations, execution control, and
 * real-time progress streaming via Server-Sent Events (SSE).
 *
 * Route registration is split by concern across sibling modules:
 * definitionRoutes (CRUD), executionRoutes (lifecycle), streamRoutes (SSE +
 * human checkpoints), adminRoutes (admin listing/toggle), and versionRoutes
 * (publish/activate). This file just wires the shared WorkflowEngine and
 * registers each group.
 *
 * @module routes/workflow/workflowRoutes
 */

import { WorkflowEngine } from '../../services/workflow/WorkflowEngine.js';
import registerDefinitionRoutes from './definitionRoutes.js';
import registerExecutionRoutes from './executionRoutes.js';
import registerStreamRoutes from './streamRoutes.js';
import registerAdminRoutes from './adminRoutes.js';
import registerVersionRoutes from './versionRoutes.js';
import { workflowClients } from './workflowRouteHelpers.js';

/**
 * Registers all workflow-related API routes.
 *
 * @param {Express} app - Express application instance
 * @param {Object} deps - Dependencies and configuration
 * @param {string} deps.basePath - Base path for API routes
 * @param {WorkflowEngine} deps.workflowEngine - Optional custom workflow engine instance
 */
export default function registerWorkflowRoutes(app, deps = {}) {
  const workflowEngine = deps.workflowEngine || new WorkflowEngine();
  const routeDeps = { ...deps, workflowEngine };

  registerDefinitionRoutes(app);
  registerExecutionRoutes(app, routeDeps);
  registerStreamRoutes(app, routeDeps);
  registerAdminRoutes(app, routeDeps);
  registerVersionRoutes(app);

  return {
    workflowEngine,
    workflowClients
  };
}

// Re-export helper functions for testing / backward compatibility
export {
  filterByPermissions,
  isAdmin,
  loadWorkflows,
  findWorkflowFile,
  validateWorkflow
} from './workflowRouteHelpers.js';
