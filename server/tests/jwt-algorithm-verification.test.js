/**
 * Simple test to verify RS256 JWT algorithm support
 * Tests that tokens can be generated and verified with both RS256 and HS256 algorithms
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Generate RSA key pair for RS256
const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = crypto.generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  }
);

const HS256_SECRET = 'test-jwt-secret-key-12345';

async function testRS256() {
  console.log('🧪 Testing RS256 JWT signing and verification...\n');

  try {
    // Sign with RS256
    const token = jwt.sign(
      {
        sub: 'user123',
        name: 'Test User',
        email: 'test@example.com',
        groups: ['users'],
        authMode: 'local'
      },
      rsaPrivateKey,
      {
        expiresIn: '7d',
        issuer: 'ihub-apps',
        audience: 'ihub-apps',
        algorithm: 'RS256'
      }
    );

    console.log('✅ Token signed with RS256 private key');
    console.log(`   Token (first 50 chars): ${token.substring(0, 50)}...\n`);

    // Verify with RS256 public key
    const decoded = jwt.verify(token, rsaPublicKey, {
      issuer: 'ihub-apps',
      audience: 'ihub-apps',
      algorithms: ['RS256']
    });

    console.log('✅ Token verified with RS256 public key');
    console.log(`   User: ${decoded.name} (${decoded.sub})\n`);

    // Try to verify with HS256 secret (should fail)
    try {
      jwt.verify(token, HS256_SECRET, {
        issuer: 'ihub-apps',
        audience: 'ihub-apps',
        algorithms: ['HS256']
      });
      console.log('❌ ERROR: RS256 token verified with HS256 secret (should have failed)');
      return false;
    } catch (error) {
      console.log('✅ RS256 token correctly rejected when verifying with HS256 secret');
      console.log(`   Error: ${error.message}\n`);
    }

    return true;
  } catch (error) {
    console.error('❌ RS256 test failed:', error);
    return false;
  }
}

async function testHS256() {
  console.log('🧪 Testing HS256 JWT signing and verification...\n');

  try {
    // Sign with HS256
    const token = jwt.sign(
      {
        sub: 'user456',
        name: 'Test User 2',
        email: 'test2@example.com',
        groups: ['users'],
        authMode: 'local'
      },
      HS256_SECRET,
      {
        expiresIn: '7d',
        issuer: 'ihub-apps',
        audience: 'ihub-apps',
        algorithm: 'HS256'
      }
    );

    console.log('✅ Token signed with HS256 secret');
    console.log(`   Token (first 50 chars): ${token.substring(0, 50)}...\n`);

    // Verify with HS256 secret
    const decoded = jwt.verify(token, HS256_SECRET, {
      issuer: 'ihub-apps',
      audience: 'ihub-apps',
      algorithms: ['HS256']
    });

    console.log('✅ Token verified with HS256 secret');
    console.log(`   User: ${decoded.name} (${decoded.sub})\n`);

    // Try to verify with RS256 public key (should fail)
    try {
      jwt.verify(token, rsaPublicKey, {
        issuer: 'ihub-apps',
        audience: 'ihub-apps',
        algorithms: ['RS256']
      });
      console.log('❌ ERROR: HS256 token verified with RS256 public key (should have failed)');
      return false;
    } catch (error) {
      console.log('✅ HS256 token correctly rejected when verifying with RS256 public key');
      console.log(`   Error: ${error.message}\n`);
    }

    return true;
  } catch (error) {
    console.error('❌ HS256 test failed:', error);
    return false;
  }
}

async function runTests() {
  console.log('═'.repeat(80));
  console.log('JWT Algorithm Support Test Suite');
  console.log('═'.repeat(80));
  console.log();

  const rs256Result = await testRS256();
  const hs256Result = await testHS256();

  console.log('═'.repeat(80));
  if (rs256Result && hs256Result) {
    console.log('✅ All tests passed!');
    console.log('═'.repeat(80));
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    console.log('═'.repeat(80));
    process.exit(1);
  }
}

runTests();
