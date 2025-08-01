#!/usr/bin/env node

/**
 * Migration script to update users.json files from old format to new format
 *
 * Changes:
 * - Replace `additionalGroups` with `internalGroups`
 * - Replace `groups` with `internalGroups` for local users
 * - Update metadata version to 2.0.0
 * - Remove legacy fallback fields
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteJSON } from '../server/utils/atomicWrite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find all users.json files in the project
function findUsersJsonFiles(dir = path.join(__dirname, '..')) {
  const usersFiles = [];

  function searchDir(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          searchDir(fullPath);
        }
      } else if (entry.name === 'users.json') {
        usersFiles.push(fullPath);
      }
    }
  }

  searchDir(dir);
  return usersFiles;
}

// Migrate a single users.json file
async function migrateUsersFile(filePath) {
  console.log(`\n📂 Processing: ${filePath}`);

  try {
    // Read existing file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const usersConfig = JSON.parse(fileContent);

    if (!usersConfig.users || typeof usersConfig.users !== 'object') {
      console.log('   ⚠️  No users object found, skipping');
      return false;
    }

    let changesCount = 0;
    let usersProcessed = 0;

    // Process each user
    for (const [userId, user] of Object.entries(usersConfig.users)) {
      usersProcessed++;
      let userChanged = false;

      // Migrate additionalGroups to internalGroups
      if (user.additionalGroups !== undefined) {
        console.log(`   🔄 User ${userId}: migrating additionalGroups to internalGroups`);
        user.internalGroups = user.additionalGroups || [];
        delete user.additionalGroups;
        userChanged = true;
      }

      // For local auth users, migrate top-level groups to internalGroups
      if (user.groups !== undefined && (!user.authMethods || user.authMethods.includes('local'))) {
        console.log(`   🔄 User ${userId}: migrating groups to internalGroups (local user)`);
        if (!user.internalGroups) {
          user.internalGroups = user.groups || [];
        }
        delete user.groups;
        userChanged = true;
      }

      // Ensure internalGroups exists as array
      if (!user.internalGroups) {
        user.internalGroups = [];
        userChanged = true;
      }

      // Remove legacy fields that are no longer used
      const legacyFields = ['additionalGroups'];
      for (const field of legacyFields) {
        if (user[field] !== undefined) {
          console.log(`   🗑️  User ${userId}: removing legacy field '${field}'`);
          delete user[field];
          userChanged = true;
        }
      }

      if (userChanged) {
        changesCount++;
      }
    }

    // Update metadata
    if (!usersConfig.metadata) {
      usersConfig.metadata = {};
    }

    const oldVersion = usersConfig.metadata.version;
    usersConfig.metadata.version = '2.0.0';
    usersConfig.metadata.lastUpdated = new Date().toISOString();
    usersConfig.metadata.migrationDate = new Date().toISOString();
    usersConfig.metadata.migratedFrom = oldVersion || '1.x.x';

    // Write updated file
    if (changesCount > 0) {
      await atomicWriteJSON(filePath, usersConfig);
      console.log(`   ✅ Migration complete: ${changesCount}/${usersProcessed} users updated`);
      return true;
    } else {
      console.log(`   ✅ No migration needed: all ${usersProcessed} users already in new format`);
      return false;
    }
  } catch (error) {
    console.error(`   ❌ Error migrating ${filePath}:`, error.message);
    return false;
  }
}

// Main migration function
async function migrateAllUsersFiles() {
  console.log('🚀 Starting users.json migration to new group handling format\n');

  // Find all users.json files
  const usersFiles = findUsersJsonFiles();

  if (usersFiles.length === 0) {
    console.log('📭 No users.json files found');
    return;
  }

  console.log(`📋 Found ${usersFiles.length} users.json file(s):`);
  usersFiles.forEach(file => console.log(`   - ${file}`));

  // Migrate each file
  let migratedCount = 0;
  for (const filePath of usersFiles) {
    const wasMigrated = await migrateUsersFile(filePath);
    if (wasMigrated) {
      migratedCount++;
    }
  }

  console.log(`\n🎉 Migration complete: ${migratedCount}/${usersFiles.length} files updated`);

  if (migratedCount > 0) {
    console.log('\n📝 Migration Summary:');
    console.log('   - additionalGroups → internalGroups');
    console.log('   - groups → internalGroups (for local users)');
    console.log('   - Updated metadata version to 2.0.0');
    console.log('   - Removed legacy fields');
    console.log('\n⚠️  Please review the changes and commit them to your repository');
  }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateAllUsersFiles().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

export { migrateAllUsersFiles, migrateUsersFile, findUsersJsonFiles };
