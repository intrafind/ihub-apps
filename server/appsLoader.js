import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getRootDir } from './pathUtils.js';

/**
 * Enhanced Apps Loader Service
 * 
 * This service loads apps from both individual files in contents/apps/ 
 * and the legacy apps.json file for backward compatibility.
 * 
 * Features:
 * - Loads individual app files from contents/apps/
 * - Backward compatible with contents/config/apps.json
 * - Filters out disabled apps
 * - Sorts apps by order field
 * - Handles missing enabled field (defaults to true)
 */

/**
 * Load apps from individual files in contents/apps/
 * @returns {Array} Array of app objects
 */
export function loadAppsFromFiles() {
    const rootDir = getRootDir();
    const appsDir = join(rootDir, 'contents', 'apps');
    
    if (!existsSync(appsDir)) {
        console.log('📁 Apps directory not found, skipping individual app files');
        return [];
    }
    
    const apps = [];
    const files = readdirSync(appsDir).filter(file => file.endsWith('.json'));
    
    console.log(`📱 Loading ${files.length} individual app files...`);
    
    for (const file of files) {
        try {
            const filePath = join(appsDir, file);
            const fileContent = readFileSync(filePath, 'utf8');
            const app = JSON.parse(fileContent);
            
            // Add enabled field if it doesn't exist (defaults to true)
            if (app.enabled === undefined) {
                app.enabled = true;
            }
            
            apps.push(app);
            console.log(`✅ Loaded ${app.id} (${app.enabled ? 'enabled' : 'disabled'})`);
        } catch (error) {
            console.error(`❌ Error loading app from ${file}:`, error.message);
        }
    }
    
    return apps;
}

/**
 * Load apps from legacy apps.json file
 * @returns {Array} Array of app objects
 */
export function loadAppsFromLegacyFile() {
    const rootDir = getRootDir();
    const legacyAppsPath = join(rootDir, 'contents', 'config', 'apps.json');
    
    if (!existsSync(legacyAppsPath)) {
        console.log('📄 Legacy apps.json not found, skipping');
        return [];
    }
    
    try {
        const fileContent = readFileSync(legacyAppsPath, 'utf8');
        const apps = JSON.parse(fileContent);
        
        console.log(`📄 Loading ${apps.length} apps from legacy apps.json...`);
        
        // Add enabled field if it doesn't exist (defaults to true)
        apps.forEach(app => {
            if (app.enabled === undefined) {
                app.enabled = true;
            }
        });
        
        return apps;
    } catch (error) {
        console.error('❌ Error loading legacy apps.json:', error.message);
        return [];
    }
}

/**
 * Load all apps from both sources
 * Individual files take precedence over legacy apps.json
 * @returns {Array} Array of enabled app objects, sorted by order
 */
export function loadAllApps() {
    const individualApps = loadAppsFromFiles();
    const legacyApps = loadAppsFromLegacyFile();
    
    // Create a map to track apps by ID
    const appsMap = new Map();
    
    // Add legacy apps first
    legacyApps.forEach(app => {
        appsMap.set(app.id, app);
    });
    
    // Individual files override legacy apps
    individualApps.forEach(app => {
        appsMap.set(app.id, app);
    });
    
    // Convert map to array and filter enabled apps
    const allApps = Array.from(appsMap.values());
    const enabledApps = allApps.filter(app => app.enabled === true);
    
    // Sort by order field (apps without order go to the end)
    enabledApps.sort((a, b) => {
        const orderA = a.order ?? 999;
        const orderB = b.order ?? 999;
        return orderA - orderB;
    });
    
    console.log(`🎯 Total apps loaded: ${allApps.length}, Enabled: ${enabledApps.length}, Disabled: ${allApps.length - enabledApps.length}`);
    
    return enabledApps;
}

/**
 * Load all apps including disabled ones (for admin purposes)
 * @returns {Array} Array of all app objects, sorted by order
 */
export function loadAllAppsIncludingDisabled() {
    const individualApps = loadAppsFromFiles();
    const legacyApps = loadAppsFromLegacyFile();
    
    // Create a map to track apps by ID
    const appsMap = new Map();
    
    // Add legacy apps first
    legacyApps.forEach(app => {
        appsMap.set(app.id, app);
    });
    
    // Individual files override legacy apps
    individualApps.forEach(app => {
        appsMap.set(app.id, app);
    });
    
    // Convert map to array
    const allApps = Array.from(appsMap.values());
    
    // Sort by order field (apps without order go to the end)
    allApps.sort((a, b) => {
        const orderA = a.order ?? 999;
        const orderB = b.order ?? 999;
        return orderA - orderB;
    });
    
    return allApps;
}