import logger from './logger.js';
import { hashPasswordWithUserId, loadUsers, saveUsers } from './userManager.js';
import { getContentsPath } from '../pathUtils.js';

function parseKnownPasswords() {
  const arg = process.argv.find(value => value.startsWith('--passwords='));
  const json = arg ? arg.substring('--passwords='.length) : process.env.REHASH_PASSWORDS_JSON;

  if (!json) {
    return {};
  }

  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid password mapping JSON: ${error.message}. Use --passwords='{"userId":"password"}'`
    );
  }
}

/**
 * Rehash existing user passwords with the new method
 */
async function rehashUserPasswords() {
  const usersFilePath = getContentsPath('config', 'users.json');

  try {
    const usersData = loadUsers(usersFilePath);
    const knownPasswords = parseKnownPasswords();

    logger.info('Rehashing passwords for existing users', { component: 'RehashPasswords' });

    for (const [userId, user] of Object.entries(usersData.users)) {
      if (knownPasswords[userId]) {
        const plainPassword = knownPasswords[userId];
        const newHash = await hashPasswordWithUserId(plainPassword, userId);

        usersData.users[userId].passwordHash = newHash;
        logger.info('Rehashed password for user', {
          component: 'RehashPasswords',
          username: user.username,
          userId
        });
      } else {
        logger.info('Skipped user - password unknown', {
          component: 'RehashPasswords',
          username: user.username,
          userId
        });
      }
    }

    // Update metadata
    usersData.metadata = {
      ...usersData.metadata,
      version: '2.0.0',
      description:
        'Local user database for iHub Apps - Updated with user-specific password hashing',
      lastUpdated: new Date().toISOString()
    };

    await saveUsers(usersData, usersFilePath);
    logger.info('Users file updated with new password hashes', { component: 'RehashPasswords' });
  } catch (error) {
    logger.error('Error rehashing passwords', { component: 'RehashPasswords', error });
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await rehashUserPasswords();
    logger.info('Password rehashing completed successfully', { component: 'RehashPasswords' });
    process.exit(0);
  } catch (error) {
    logger.error('Password rehashing failed', { component: 'RehashPasswords', error });
    process.exit(1);
  }
}

export { rehashUserPasswords };
