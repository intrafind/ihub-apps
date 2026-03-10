import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';
import logger from './logger.js';

/**
 * Ensures that providers.json has all the default providers
 * This is used for migrations when new providers are added to defaults
 */
export async function ensureDefaultProviders() {
  try {
    const rootDir = getRootDir();
    const providersPath = join(rootDir, 'contents', 'config', 'providers.json');
    const defaultProvidersPath = join(rootDir, 'server', 'defaults', 'config', 'providers.json');

    // Read default providers
    const defaultProvidersContent = await fs.readFile(defaultProvidersPath, 'utf8');
    const defaultProviders = JSON.parse(defaultProvidersContent).providers;

    // Check if runtime providers.json exists
    if (!existsSync(providersPath)) {
      logger.info('providers.json does not exist, will be created by copyDefaultConfiguration', {
        component: 'ProviderMigration'
      });
      return;
    }

    // Read existing providers
    const existingProvidersContent = await fs.readFile(providersPath, 'utf8');
    const existingProviders = JSON.parse(existingProvidersContent).providers;

    // Find providers that exist in defaults but not in runtime
    const existingIds = new Set(existingProviders.map(p => p.id));
    const missingProviders = defaultProviders.filter(p => !existingIds.has(p.id));

    if (missingProviders.length === 0) {
      logger.info('All default providers already present in providers.json', {
        component: 'ProviderMigration'
      });
      return;
    }

    logger.info(`Adding ${missingProviders.length} missing default provider(s) to providers.json`, {
      component: 'ProviderMigration',
      providers: missingProviders.map(p => `${p.id} (${p.category || 'llm'})`)
    });

    // Add missing providers
    const updatedProviders = [...existingProviders, ...missingProviders];

    // Save updated providers
    await fs.writeFile(providersPath, JSON.stringify({ providers: updatedProviders }, null, 2));
    logger.info('providers.json updated with missing default providers', {
      component: 'ProviderMigration'
    });
  } catch (error) {
    logger.error('Error ensuring default providers', {
      component: 'ProviderMigration',
      error: error.message
    });
    // Don't throw - this is a non-critical operation
  }
}
