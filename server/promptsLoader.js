import { readFileSync, existsSync, readdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from './pathUtils.js';

/**
 * Enhanced Prompts Loader Service
 *
 * This service loads prompts from both individual files in contents/prompts/
 * and the legacy prompts.json file for backward compatibility.
 *
 * Features:
 * - Loads individual prompt files from contents/prompts/
 * - Backward compatible with contents/config/prompts.json
 * - Filters out disabled prompts
 * - Sorts prompts by order field
 * - Handles missing enabled field (defaults to true)
 */

/**
 * Load prompts from individual files in contents/prompts/
 * @returns {Array} Array of prompt objects
 */
export async function loadPromptsFromFiles() {
  const rootDir = getRootDir();
  const promptsDir = join(rootDir, 'contents', 'prompts');

  if (!existsSync(promptsDir)) {
    console.log('📁 Prompts directory not found, skipping individual prompt files');
    return [];
  }

  const prompts = [];
  const dirContents = await fs.readdir(promptsDir);
  const files = dirContents.filter(file => file.endsWith('.json'));

  console.log(`💬 Loading ${files.length} individual prompt files...`);

  for (const file of files) {
    try {
      const filePath = join(promptsDir, file);
      const content = await fs.readFile(filePath, 'utf8');
      const prompt = JSON.parse(content);

      // Validate required fields
      if (!prompt.id || !prompt.name || !prompt.prompt) {
        console.warn(`⚠️  Invalid prompt in ${file}: missing required fields`);
        continue;
      }

      prompts.push(prompt);
    } catch (error) {
      console.error(`❌ Error loading prompt file ${file}:`, error.message);
    }
  }

  return prompts;
}

/**
 * Load prompts from legacy prompts.json file
 * @returns {Array} Array of prompt objects
 */
export async function loadPromptsFromLegacyFile() {
  const rootDir = getRootDir();
  const promptsFile = join(rootDir, 'contents', 'config', 'prompts.json');

  if (!existsSync(promptsFile)) {
    console.log('📄 Legacy prompts.json not found');
    return [];
  }

  try {
    console.log('📄 Loading legacy prompts.json...');
    const content = await fs.readFile(promptsFile, 'utf8');
    const prompts = JSON.parse(content);

    if (!Array.isArray(prompts)) {
      console.warn('⚠️  Legacy prompts.json is not an array');
      return [];
    }

    return prompts;
  } catch (error) {
    console.error('❌ Error loading legacy prompts.json:', error.message);
    return [];
  }
}

/**
 * Load all prompts from both individual files and legacy file
 * @param {boolean} includeDisabled Include disabled prompts
 * @returns {Array} Array of prompt objects
 */
export async function loadAllPrompts(includeDisabled = false) {
  const individualPrompts = await loadPromptsFromFiles();
  const legacyPrompts = await loadPromptsFromLegacyFile();

  // Combine prompts, giving priority to individual files
  const allPrompts = [...individualPrompts];

  // Add legacy prompts that don't exist in individual files
  for (const legacyPrompt of legacyPrompts) {
    const existsInIndividual = allPrompts.some(p => p.id === legacyPrompt.id);
    if (!existsInIndividual) {
      allPrompts.push(legacyPrompt);
    }
  }

  // Filter out disabled prompts unless explicitly requested
  let filteredPrompts = allPrompts;
  if (!includeDisabled) {
    filteredPrompts = allPrompts.filter(prompt => prompt.enabled !== false);
  }

  // Sort by order field, then by name
  filteredPrompts.sort((a, b) => {
    // First by order (if defined)
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order;
    }
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;

    // Then by name
    const aName = typeof a.name === 'object' ? a.name.en || '' : a.name || '';
    const bName = typeof b.name === 'object' ? b.name.en || '' : b.name || '';
    return aName.localeCompare(bName);
  });

  console.log(
    `💬 Loaded ${filteredPrompts.length} prompts (${includeDisabled ? 'including' : 'excluding'} disabled)`
  );
  return filteredPrompts;
}
