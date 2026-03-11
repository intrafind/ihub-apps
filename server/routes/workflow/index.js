/**
 * Workflow Routes Index
 *
 * Exports all workflow-related route registration functions.
 *
 * @module routes/workflow
 */

import registerWorkflowRoutes from './workflowRoutes.js';
import { registerTriggerRoutes } from './triggerRoutes.js';

// Named exports
export { registerWorkflowRoutes, registerTriggerRoutes };
export {
  filterByPermissions,
  isAdmin,
  loadWorkflows,
  findWorkflowFile,
  validateWorkflow
} from './workflowRoutes.js';

// Default export for compatibility with server.js
export default registerWorkflowRoutes;
