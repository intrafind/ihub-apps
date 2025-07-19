import registerAdminAuthRoutes from './admin/auth.js';
import registerAdminCacheRoutes from './admin/cache.js';
import registerAdminConfigRoutes from './admin/configs.js';
import registerAdminAppsRoutes from './admin/apps.js';
import registerAdminModelsRoutes from './admin/models.js';
import registerAdminPromptsRoutes from './admin/prompts.js';
import registerAdminTranslateRoute from './admin/translate.js';
import registerAdminPagesRoutes from './admin/pages.js';

export default function registerAdminRoutes(app) {
  registerAdminAuthRoutes(app);
  registerAdminCacheRoutes(app);
  registerAdminConfigRoutes(app);
  registerAdminAppsRoutes(app);
  registerAdminModelsRoutes(app);
  registerAdminPromptsRoutes(app);
  registerAdminTranslateRoute(app);
  registerAdminPagesRoutes(app);
}
