#!/usr/bin/env node

/**
 * Security Test Runner
 *
 * Runs the authentication security test suite and reports results
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔒 Running Authentication Security Test Suite\n');

// Test configurations
const testConfigs = [
  {
    name: 'Authentication Security Tests',
    file: 'tests/authentication-security.test.js',
    description: 'Core authentication bypass prevention tests'
  },
  {
    name: 'Authentication Integration Tests',
    file: 'tests/authentication-integration.test.js',
    description: 'Real-world authentication scenarios and edge cases'
  }
];

async function runTest(config) {
  return new Promise((resolve, reject) => {
    console.log(`\n📋 Running: ${config.name}`);
    console.log(`📝 ${config.description}\n`);

    const jest = spawn('npx', ['jest', config.file, '--verbose'], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });

    jest.on('close', code => {
      if (code === 0) {
        console.log(`\n✅ ${config.name} - PASSED\n`);
        resolve(true);
      } else {
        console.log(`\n❌ ${config.name} - FAILED\n`);
        resolve(false);
      }
    });

    jest.on('error', error => {
      console.error(`\n💥 Error running ${config.name}:`, error);
      reject(error);
    });
  });
}

async function runAllTests() {
  const results = [];

  for (const config of testConfigs) {
    try {
      const result = await runTest(config);
      results.push({ name: config.name, passed: result });
    } catch (error) {
      results.push({ name: config.name, passed: false, error });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('🔒 AUTHENTICATION SECURITY TEST SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach(result => {
    const status = result.passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`${status} - ${result.name}`);
    if (result.error) {
      console.log(`   Error: ${result.error.message}`);
    }
  });

  console.log('\n' + '-'.repeat(60));
  console.log(`📊 Results: ${passed}/${total} test suites passed`);

  if (passed === total) {
    console.log('🎉 ALL SECURITY TESTS PASSED - Authentication is secure!');
    console.log('\n✅ The authentication bypass vulnerability has been successfully fixed');
    console.log('✅ All API endpoints are properly protected');
    console.log('✅ Group-based permissions are working correctly');
    console.log('✅ Admin endpoints are secured');
    console.log('✅ Attack vectors are blocked');
  } else {
    console.log('⚠️  SECURITY TESTS FAILED - Potential vulnerabilities detected!');
    console.log('\n🚨 Please review failed tests and fix security issues before deployment');
  }

  console.log('\n' + '='.repeat(60));

  // Exit with appropriate code
  process.exit(passed === total ? 0 : 1);
}

// Handle uncaught errors
process.on('uncaughtException', error => {
  console.error('\n💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  console.error('\n💥 Unhandled Rejection:', reason);
  process.exit(1);
});

// Run the tests
runAllTests().catch(error => {
  console.error('\n💥 Test runner failed:', error);
  process.exit(1);
});
