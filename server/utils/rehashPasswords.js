import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Hash password with user ID as salt for unique hashes
 * @param {string} password - Plain text password
 * @param {string} userId - User ID to use as salt
 * @returns {Promise<string>} Hashed password
 */
async function hashPasswordWithUserId(password, userId) {
  // Create a deterministic salt from user ID
  const salt = await bcrypt.genSalt(12);
  
  // Combine password with user ID for unique hash
  const passwordWithUserId = `${userId}:${password}`;
  
  return await bcrypt.hash(passwordWithUserId, salt);
}

/**
 * Rehash existing user passwords with the new method
 */
async function rehashUserPasswords() {
  const usersFilePath = path.join(__dirname, '../../contents/config/users.json');
  
  try {
    // Read existing users file
    const usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
    
    console.log('Rehashing passwords for existing users...');
    
    // Known passwords for demo users (in production, you'd need to handle this differently)
    const knownPasswords = {
      'user_demo_admin': 'password123',
      'user_demo_user': 'password123'
    };
    
    for (const [userId, user] of Object.entries(usersData.users)) {
      if (knownPasswords[userId]) {
        const plainPassword = knownPasswords[userId];
        const newHash = await hashPasswordWithUserId(plainPassword, userId);
        
        usersData.users[userId].passwordHash = newHash;
        console.log(`✅ Rehashed password for user: ${user.username} (${userId})`);
      } else {
        console.log(`⚠️  Skipped user ${user.username} (${userId}) - password unknown`);
      }
    }
    
    // Update metadata
    usersData.metadata = {
      ...usersData.metadata,
      version: "2.0.0",
      description: "Local user database for AI Hub Apps - Updated with user-specific password hashing",
      lastUpdated: new Date().toISOString(),
      passwordHashingMethod: "bcrypt + userId salt",
      note: "Passwords are now hashed with user ID for unique hashes. Demo users still use 'password123'."
    };
    
    // Write updated file
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
    console.log('✅ Users file updated with new password hashes');
    
  } catch (error) {
    console.error('❌ Error rehashing passwords:', error);
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  rehashUserPasswords()
    .then(() => {
      console.log('🎉 Password rehashing completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Password rehashing failed:', error);
      process.exit(1);
    });
}

export { hashPasswordWithUserId, rehashUserPasswords };