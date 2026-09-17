import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { agentProfileSchema, knownAgentProfileKeys } from './validators/agentProfileSchema.js';

/**
 * Agent Profile Loader
 *
 * Loads agent profiles from individual files in contents/agents/profiles/.
 * Mirrors appsLoader / modelsLoader patterns.
 */

const agentsLoader = createResourceLoader({
  resourceName: 'Agent Profiles',
  legacyPath: 'config/agents.json',
  individualPath: 'agents/profiles',
  validateItem: createSchemaValidator(agentProfileSchema, knownAgentProfileKeys)
});

export async function loadAllAgentProfiles(includeDisabled = false, verbose = true) {
  return await agentsLoader.loadAll(includeDisabled, verbose);
}

export async function loadAgentProfilesFromFiles(verbose = true) {
  return await agentsLoader.loadFromFiles(verbose);
}
