#!/usr/bin/env node

/**
 * Manual test for Office 365 OAuth callback URL auto-detection
 * 
 * This test verifies that the _buildCallbackUrl method correctly extracts
 * the protocol and host from the request object, including support for
 * reverse proxy headers (X-Forwarded-Proto, X-Forwarded-Host).
 */

import office365Service from '../services/integrations/Office365Service.js';

// Mock Express request object factory
function createMockRequest({ protocol = 'http', host = 'localhost:3000', forwardedProto, forwardedHost }) {
  const headers = {};
  
  if (forwardedProto) {
    headers['x-forwarded-proto'] = forwardedProto;
  }
  
  if (forwardedHost) {
    headers['x-forwarded-host'] = forwardedHost;
  }
  
  return {
    protocol,
    get(headerName) {
      const lowerName = headerName.toLowerCase();
      if (lowerName === 'x-forwarded-proto') return headers['x-forwarded-proto'];
      if (lowerName === 'x-forwarded-host') return headers['x-forwarded-host'];
      if (lowerName === 'host') return host;
      return undefined;
    }
  };
}

console.log('🧪 Testing Office 365 OAuth Callback URL Auto-Detection\n');

// Test 1: Basic HTTP request
console.log('Test 1: Basic HTTP request');
try {
  const req1 = createMockRequest({ protocol: 'http', host: 'localhost:3000' });
  const url1 = office365Service._buildCallbackUrl(req1);
  console.log(`✅ Result: ${url1}`);
  console.log(`   Expected: http://localhost:3000/api/integrations/office365/callback`);
  console.log(`   Match: ${url1 === 'http://localhost:3000/api/integrations/office365/callback' ? '✓' : '✗'}\n`);
} catch (error) {
  console.log(`❌ Error: ${error.message}\n`);
}

// Test 2: HTTPS request with domain
console.log('Test 2: HTTPS request with domain');
try {
  const req2 = createMockRequest({ protocol: 'https', host: 'ihub.example.com' });
  const url2 = office365Service._buildCallbackUrl(req2);
  console.log(`✅ Result: ${url2}`);
  console.log(`   Expected: https://ihub.example.com/api/integrations/office365/callback`);
  console.log(`   Match: ${url2 === 'https://ihub.example.com/api/integrations/office365/callback' ? '✓' : '✗'}\n`);
} catch (error) {
  console.log(`❌ Error: ${error.message}\n`);
}

// Test 3: Behind reverse proxy with X-Forwarded-Proto
console.log('Test 3: Behind reverse proxy with X-Forwarded-Proto');
try {
  const req3 = createMockRequest({ 
    protocol: 'http', 
    host: 'localhost:8080',
    forwardedProto: 'https',
    forwardedHost: 'ihub.local.intrafind.io'
  });
  const url3 = office365Service._buildCallbackUrl(req3);
  console.log(`✅ Result: ${url3}`);
  console.log(`   Expected: https://ihub.local.intrafind.io/api/integrations/office365/callback`);
  console.log(`   Match: ${url3 === 'https://ihub.local.intrafind.io/api/integrations/office365/callback' ? '✓' : '✗'}\n`);
} catch (error) {
  console.log(`❌ Error: ${error.message}\n`);
}

// Test 4: Subpath deployment (should not affect callback URL)
console.log('Test 4: Subpath deployment (callback URL path is always absolute)');
try {
  const req4 = createMockRequest({ 
    protocol: 'https', 
    host: 'example.com'
  });
  const url4 = office365Service._buildCallbackUrl(req4);
  console.log(`✅ Result: ${url4}`);
  console.log(`   Expected: https://example.com/api/integrations/office365/callback`);
  console.log(`   Match: ${url4 === 'https://example.com/api/integrations/office365/callback' ? '✓' : '✗'}\n`);
} catch (error) {
  console.log(`❌ Error: ${error.message}\n`);
}

// Test 5: Production scenario (HTTPS + custom domain)
console.log('Test 5: Production scenario (HTTPS + custom domain)');
try {
  const req5 = createMockRequest({ 
    protocol: 'https', 
    host: 'apps.company.com'
  });
  const url5 = office365Service._buildCallbackUrl(req5);
  console.log(`✅ Result: ${url5}`);
  console.log(`   Expected: https://apps.company.com/api/integrations/office365/callback`);
  console.log(`   Match: ${url5 === 'https://apps.company.com/api/integrations/office365/callback' ? '✓' : '✗'}\n`);
} catch (error) {
  console.log(`❌ Error: ${error.message}\n`);
}

// Test 6: Error case - no host
console.log('Test 6: Error case - no host available');
try {
  const req6 = {
    protocol: 'https',
    get() { return undefined; }
  };
  const url6 = office365Service._buildCallbackUrl(req6);
  console.log(`❌ Should have thrown error but got: ${url6}\n`);
} catch (error) {
  console.log(`✅ Error thrown as expected: ${error.message}\n`);
}

console.log('🎉 All tests completed!');
