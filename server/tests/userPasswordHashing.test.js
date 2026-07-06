import assert from 'assert';
import bcrypt from 'bcryptjs';
import { hashPasswordWithUserId } from '../utils/userManager.js';

async function run() {
  const password = 'test-password';
  const userId = 'user_123';
  const hash = await hashPasswordWithUserId(password, userId);

  assert.ok(await bcrypt.compare(`${userId}:${password}`, hash));
  assert.ok(!(await bcrypt.compare(`other_user:${password}`, hash)));
  console.log('✓ hashPasswordWithUserId hashes with user-scoped input');
}

try {
  await run();
} catch (error) {
  console.error('✗ userPasswordHashing test failed');
  console.error(error);
  process.exit(1);
}
