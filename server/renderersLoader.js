import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from './pathUtils.js';

/**
 * Renderers Loader Service
 *
 * This service loads custom response renderers from both:
 * - server/defaults/renderers/ (built-in renderers)
 * - contents/renderers/ (customer-specific renderers)
 *
 * Renderers are JSX files that export a React component for rendering
 * structured JSON responses in custom formats.
 */

/**
 * Load renderers from a specific directory
 * @param {string} dirPath - Absolute path to renderers directory
 * @param {string} source - Source identifier ('defaults' or 'contents')
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of renderer objects
 */
async function loadRenderersFromDirectory(dirPath, source, verbose = true) {
  if (!existsSync(dirPath)) {
    if (verbose) {
      console.log(`📁 ${source} renderers directory not found, skipping`);
    }
    return [];
  }

  const renderers = [];
  const dirContents = await fs.readdir(dirPath);
  const files = dirContents.filter(file => file.endsWith('.jsx') || file.endsWith('.js'));

  if (verbose && files.length > 0) {
    console.log(`📱 Found ${files.length} renderer file(s) in ${source}`);
  }

  const loadedItems = [];
  const errorItems = [];

  for (const file of files) {
    try {
      const filePath = join(dirPath, file);
      const fileContent = await fs.readFile(filePath, 'utf8');
      
      // Extract renderer ID from filename (remove extension)
      const id = file.replace(/\.(jsx|js)$/, '');
      
      // Create renderer object
      const renderer = {
        id,
        filename: file,
        source, // 'defaults' or 'contents'
        code: fileContent,
        enabled: true
      };

      renderers.push(renderer);
      
      if (verbose) {
        loadedItems.push(`   ✅ ${id} (${source})`);
      }
    } catch (error) {
      errorItems.push(`   ❌ ${file}: ${error.message}`);
    }
  }

  // Log all items together for better clustering
  if (verbose && loadedItems.length > 0) {
    console.log(loadedItems.join('\n'));
  }
  if (errorItems.length > 0) {
    console.log(errorItems.join('\n'));
  }

  return renderers;
}

/**
 * Load all renderers from both defaults and contents directories
 * Contents renderers override defaults with the same ID
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of renderer objects
 */
export async function loadAllRenderers(verbose = true) {
  if (verbose) {
    console.log('\n━━━ Loading Custom Response Renderers ━━━');
  }

  const rootDir = getRootDir();
  
  // Load from defaults directory
  const defaultsPath = join(rootDir, 'server', 'defaults', 'renderers');
  const defaultRenderers = await loadRenderersFromDirectory(defaultsPath, 'defaults', verbose);
  
  // Load from contents directory (create if doesn't exist)
  const contentsPath = join(rootDir, 'contents', 'renderers');
  
  // Ensure contents/renderers directory exists
  if (!existsSync(contentsPath)) {
    try {
      await fs.mkdir(contentsPath, { recursive: true });
      if (verbose) {
        console.log(`📁 Created contents/renderers directory: ${contentsPath}`);
      }
    } catch (error) {
      console.error(`Failed to create contents/renderers directory: ${error.message}`);
    }
  }
  
  const contentRenderers = await loadRenderersFromDirectory(contentsPath, 'contents', verbose);
  
  // Merge renderers - contents overrides defaults
  const rendererMap = new Map();
  
  // Add defaults first
  defaultRenderers.forEach(renderer => {
    rendererMap.set(renderer.id, renderer);
  });
  
  // Override with contents (if any)
  contentRenderers.forEach(renderer => {
    if (rendererMap.has(renderer.id) && verbose) {
      console.log(`   🔄 Overriding default renderer: ${renderer.id}`);
    }
    rendererMap.set(renderer.id, renderer);
  });
  
  const allRenderers = Array.from(rendererMap.values());
  
  if (verbose) {
    const enabledCount = allRenderers.filter(r => r.enabled).length;
    console.log(`📊 Summary: ${allRenderers.length} total renderers (${enabledCount} enabled)`);
  }
  
  return allRenderers;
}

/**
 * Get a specific renderer by ID
 * @param {string} rendererId - The renderer ID
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Object|null} Renderer object or null if not found
 */
export async function getRendererById(rendererId, verbose = false) {
  const renderers = await loadAllRenderers(verbose);
  return renderers.find(r => r.id === rendererId) || null;
}
