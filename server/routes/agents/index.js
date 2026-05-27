import registerAgentProfileRoutes from './profiles.js';
import registerAgentRunRoutes from './runs.js';
import registerAgentArtifactRoutes from './artifacts.js';

export default function registerAgentRoutes(app) {
  registerAgentProfileRoutes(app);
  registerAgentRunRoutes(app);
  registerAgentArtifactRoutes(app);
}
