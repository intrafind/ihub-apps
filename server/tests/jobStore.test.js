import assert from 'assert';
import { createJob, getJob, canAccessJob, listJobs } from '../routes/toolsService/jobStore.js';
import logger from '../utils/logger.js';

// Test canAccessJob with anonymous users
function testAnonymousJobAccess() {
  // Create an anonymous job (userId is undefined)
  const anonymousJob = createJob('ocr', undefined, { test: 'data' });

  // Anonymous user (no user object) should be able to access anonymous jobs
  assert.strictEqual(
    canAccessJob(anonymousJob, undefined),
    true,
    'Anonymous user should access anonymous job'
  );

  // Anonymous user (user with no id) should be able to access anonymous jobs
  assert.strictEqual(
    canAccessJob(anonymousJob, {}),
    true,
    'Anonymous user (empty object) should access anonymous job'
  );

  // Authenticated user should NOT be able to access anonymous jobs
  const authenticatedUser = { id: 'user123', permissions: {} };
  assert.strictEqual(
    canAccessJob(anonymousJob, authenticatedUser),
    false,
    'Authenticated user should NOT access anonymous job'
  );

  logger.info('✓ Anonymous job access test passed');
}

// Test canAccessJob with authenticated users
function testAuthenticatedJobAccess() {
  const user = { id: 'user123', permissions: {} };
  const userJob = createJob('ocr', user.id, { test: 'data' });

  // User should be able to access their own job
  assert.strictEqual(canAccessJob(userJob, user), true, 'User should access their own job');

  // Another user should NOT be able to access the job
  const otherUser = { id: 'user456', permissions: {} };
  assert.strictEqual(canAccessJob(userJob, otherUser), false, 'Other user should NOT access job');

  // Anonymous user should NOT be able to access authenticated user's job
  assert.strictEqual(
    canAccessJob(userJob, undefined),
    false,
    'Anonymous user should NOT access authenticated job'
  );

  logger.info('✓ Authenticated job access test passed');
}

// Test canAccessJob with admin users
function testAdminJobAccess() {
  const admin = { id: 'admin1', permissions: { adminAccess: true } };
  const userJob = createJob('ocr', 'user123', { test: 'data' });
  const anonymousJob = createJob('ocr', undefined, { test: 'data' });

  // Admin should be able to access any job
  assert.strictEqual(canAccessJob(userJob, admin), true, 'Admin should access user job');
  assert.strictEqual(canAccessJob(anonymousJob, admin), true, 'Admin should access anonymous job');

  logger.info('✓ Admin job access test passed');
}

// Test listJobs with anonymous users
function testListJobsAnonymous() {
  // Create multiple jobs
  const anonymousJob1 = createJob('ocr', undefined, { test: 'data1' });
  const anonymousJob2 = createJob('ocr', undefined, { test: 'data2' });
  const userJob = createJob('ocr', 'user123', { test: 'data3' });

  // Anonymous user should only see anonymous jobs
  const anonymousJobs = listJobs(undefined, false);
  const anonymousJobIds = anonymousJobs.map(j => j.id);

  assert.ok(anonymousJobIds.includes(anonymousJob1.id), 'Should include anonymous job 1');
  assert.ok(anonymousJobIds.includes(anonymousJob2.id), 'Should include anonymous job 2');
  assert.ok(!anonymousJobIds.includes(userJob.id), 'Should NOT include user job');

  logger.info('✓ List jobs for anonymous user test passed');
}

// Test listJobs with authenticated users
function testListJobsAuthenticated() {
  const user1Job = createJob('ocr', 'user123', { test: 'data1' });
  const user2Job = createJob('ocr', 'user456', { test: 'data2' });
  const anonymousJob = createJob('ocr', undefined, { test: 'data3' });

  // User should only see their own jobs
  const user1Jobs = listJobs('user123', false);
  const user1JobIds = user1Jobs.map(j => j.id);

  assert.ok(user1JobIds.includes(user1Job.id), 'Should include user1 job');
  assert.ok(!user1JobIds.includes(user2Job.id), 'Should NOT include user2 job');
  assert.ok(!user1JobIds.includes(anonymousJob.id), 'Should NOT include anonymous job');

  logger.info('✓ List jobs for authenticated user test passed');
}

// Test listJobs with admin users
function testListJobsAdmin() {
  const userJob = createJob('ocr', 'user123', { test: 'data1' });
  const anonymousJob = createJob('ocr', undefined, { test: 'data2' });

  // Admin should see all jobs
  const adminJobs = listJobs('admin1', true);
  const adminJobIds = adminJobs.map(j => j.id);

  assert.ok(adminJobIds.includes(userJob.id), 'Admin should see user job');
  assert.ok(adminJobIds.includes(anonymousJob.id), 'Admin should see anonymous job');

  logger.info('✓ List jobs for admin test passed');
}

// Run all tests
try {
  logger.info('Running job store tests...');
  testAnonymousJobAccess();
  testAuthenticatedJobAccess();
  testAdminJobAccess();
  testListJobsAnonymous();
  testListJobsAuthenticated();
  testListJobsAdmin();
  logger.info('✅ All job store tests passed!');
} catch (error) {
  logger.error('❌ Job store test failed:', error);
  process.exit(1);
}
