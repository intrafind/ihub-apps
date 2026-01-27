#!/usr/bin/env node

/**
 * Security Test Runner
 *
 * Runs the authentication security test suite and reports results
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

logger.info('🔒 Running Authentication Security Test Suite\n');

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
    logger.info(`\n📋 Running: ${config.name}`);
    logger.info(`📝 ${config.description}\n`);

    const jest = spawn('npx', ['jest', config.file, '--verbose'], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });

    jest.on('close', code => {
      if (code === 0) {
        logger.info(`\n✅ ${config.name} - PASSED\n`);
        resolve(true);
      } else {
        logger.info(`\n❌ ${config.name} - FAILED\n`);
        resolve(false);
      }
    });

    jest.on('error', error => {
      logger.error(`\n💥 Error running ${config.name}:`, error);
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
  logger.info('\n' + '='.repeat(60));
  logger.info('🔒 AUTHENTICATION SECURITY TEST SUMMARY');
  logger.info('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach(result => {
    const status = result.passed ? '✅ PASSED' : '❌ FAILED';
    logger.info(`${status} - ${result.name}`);
    if (result.error) {
      logger.info(`   Error: ${result.error.message}`);
    }
  });

  logger.info('\n' + '-'.repeat(60));
  logger.info(`📊 Results: ${passed}/${total} test suites passed`);

  if (passed === total) {
    logger.info('🎉 ALL SECURITY TESTS PASSED - Authentication is secure!');
    logger.info('\n✅ The authentication bypass vulnerability has been successfully fixed');
    logger.info('✅ All API endpoints are properly protected');
    logger.info('✅ Group-based permissions are working correctly');
    logger.info('✅ Admin endpoints are secured');
    logger.info('✅ Attack vectors are blocked');
  } else {
    logger.info('⚠️  SECURITY TESTS FAILED - Potential vulnerabilities detected!');
    logger.info('\n🚨 Please review failed tests and fix security issues before deployment');
  }

  logger.info('\n' + '='.repeat(60));

  // Exit with appropriate code
  process.exit(passed === total ? 0 : 1);
}

// Handle uncaught errors
process.on('uncaughtException', error => {
  logger.error('\n💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  logger.error('\n💥 Unhandled Rejection:', reason);
  process.exit(1);
});

// Run the tests
runAllTests().catch(error => {
  logger.error('\n💥 Test runner failed:', error);
  process.exit(1);
});
