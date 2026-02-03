/**
 * Test suite for JWT verification using jose library
 * Ensures the replacement of jwk-to-pem with jose maintains functionality
 */

import * as jose from 'jose';
import { strict as assert } from 'assert';

async function testJoseJwtVerification() {
  console.log('🧪 Testing jose library JWT verification...\n');

  try {
    // 1. Generate a test key pair
    console.log('1️⃣ Generating RSA key pair...');
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    console.log('   ✅ Key pair generated\n');

    // 2. Export public key as JWK
    console.log('2️⃣ Exporting public key as JWK...');
    const publicJWK = await jose.exportJWK(publicKey);
    console.log('   ✅ Public JWK:', JSON.stringify(publicJWK, null, 2), '\n');

    // 3. Create a JWT
    console.log('3️⃣ Creating JWT with test claims...');
    const jwt = await new jose.SignJWT({
      sub: 'test-user-123',
      email: 'test@example.com',
      groups: ['users', 'developers'],
      preferred_username: 'testuser'
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://test-issuer.example.com')
      .setAudience('test-audience')
      .setExpirationTime('2h')
      .setIssuedAt()
      .sign(privateKey);

    console.log('   ✅ JWT created:', jwt.substring(0, 50) + '...\n');

    // 4. Import JWK and verify JWT (simulating proxy auth flow)
    console.log('4️⃣ Importing JWK and verifying JWT...');
    const importedKey = await jose.importJWK(publicJWK, 'RS256');
    const { payload } = await jose.jwtVerify(jwt, importedKey, {
      issuer: 'https://test-issuer.example.com',
      audience: 'test-audience'
    });

    console.log('   ✅ JWT verified successfully!');
    console.log('   📋 Payload:', JSON.stringify(payload, null, 2), '\n');

    // 5. Assertions
    console.log('5️⃣ Running assertions...');
    assert.equal(payload.sub, 'test-user-123', 'Subject should match');
    assert.equal(payload.email, 'test@example.com', 'Email should match');
    assert.deepEqual(payload.groups, ['users', 'developers'], 'Groups should match');
    assert.equal(payload.iss, 'https://test-issuer.example.com', 'Issuer should match');
    assert.equal(payload.aud, 'test-audience', 'Audience should match');
    console.log('   ✅ All assertions passed!\n');

    // 6. Test with JWK Set (JWKS) format
    console.log('6️⃣ Testing JWKS format (as used in proxyAuth.js)...');
    const jwks = {
      keys: [
        {
          ...publicJWK,
          kid: 'test-key-1',
          use: 'sig',
          alg: 'RS256'
        }
      ]
    };

    // Simulate finding the right key by kid
    const header = jose.decodeProtectedHeader(jwt);
    const matchingKey = jwks.keys.find(k => k.kid === header.kid);
    assert(matchingKey, 'Should find matching key by kid');

    const importedFromJwks = await jose.importJWK(matchingKey, 'RS256');
    const { payload: payload2 } = await jose.jwtVerify(jwt, importedFromJwks, {
      issuer: 'https://test-issuer.example.com',
      audience: 'test-audience'
    });

    assert.equal(payload2.sub, 'test-user-123', 'Payload from JWKS should match');
    console.log('   ✅ JWKS verification successful!\n');

    // 7. Test error handling - wrong issuer
    console.log('7️⃣ Testing error handling (wrong issuer)...');
    try {
      await jose.jwtVerify(jwt, importedKey, {
        issuer: 'https://wrong-issuer.example.com',
        audience: 'test-audience'
      });
      throw new Error('Should have thrown an error for wrong issuer');
    } catch (err) {
      if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
        console.log('   ✅ Correctly rejected JWT with wrong issuer\n');
      } else {
        throw err;
      }
    }

    // 8. Test error handling - wrong audience
    console.log('8️⃣ Testing error handling (wrong audience)...');
    try {
      await jose.jwtVerify(jwt, importedKey, {
        issuer: 'https://test-issuer.example.com',
        audience: 'wrong-audience'
      });
      throw new Error('Should have thrown an error for wrong audience');
    } catch (err) {
      if (err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
        console.log('   ✅ Correctly rejected JWT with wrong audience\n');
      } else {
        throw err;
      }
    }

    console.log('✅ All tests passed! jose library is working correctly.\n');
    console.log('🎉 JWT verification with jose library is fully functional!');
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

// Run the test
testJoseJwtVerification()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
