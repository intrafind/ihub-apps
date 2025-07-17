import registerAdminAuthRoutes from './admin/auth.js';
import registerAdminCacheRoutes from './admin/cache.js';
import registerAdminAppsRoutes from './admin/apps.js';
import registerAdminModelsRoutes from './admin/models.js';
import registerAdminPromptsRoutes from './admin/prompts.js';

export default function registerAdminRoutes(app) {
  registerAdminAuthRoutes(app);
  registerAdminCacheRoutes(app);
  registerAdminAppsRoutes(app);
  registerAdminModelsRoutes(app);
  registerAdminPromptsRoutes(app);
}
