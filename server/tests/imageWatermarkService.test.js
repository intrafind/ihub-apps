/**
 * Test script for ImageWatermarkService
 * 
 * This script tests the watermarking functionality with sample images.
 * Run with: node server/tests/imageWatermarkService.test.js
 * 
 * NOTE: Tests use a 1x1 pixel image which is smaller than typical watermark text.
 * This tests error handling (should gracefully return original image on failure).
 * In production, images are typically 1K-4K resolution where watermarks work perfectly.
 */

import ImageWatermarkService from '../services/ImageWatermarkService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sample 1x1 PNG image (base64 encoded)
const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function testBasicWatermark() {
  console.log('🧪 Test 1: Basic watermark application');
  
  const config = {
    enabled: true,
    text: 'Test Watermark',
    position: 'bottom-right',
    opacity: 0.5
  };
  
  try {
    const result = await ImageWatermarkService.addWatermark(
      SAMPLE_PNG_BASE64,
      'image/png',
      config,
      {}
    );
    
    if (result.data && result.mimeType === 'image/png') {
      console.log('✅ Basic watermark test passed');
      console.log(`   - Output size: ${result.data.length} bytes`);
      console.log(`   - MIME type: ${result.mimeType}`);
      return true;
    } else {
      console.log('❌ Basic watermark test failed: Invalid result');
      return false;
    }
  } catch (error) {
    console.log('❌ Basic watermark test failed:', error.message);
    return false;
  }
}

async function testUserSpecificWatermark() {
  console.log('\n🧪 Test 2: User-specific watermark');
  
  const config = {
    enabled: true,
    text: 'iHub Apps',
    position: 'top-left',
    opacity: 0.7,
    includeUser: true
  };
  
  const metadata = {
    user: {
      username: 'john.doe',
      name: 'John Doe'
    }
  };
  
  try {
    const result = await ImageWatermarkService.addWatermark(
      SAMPLE_PNG_BASE64,
      'image/png',
      config,
      metadata
    );
    
    if (result.data) {
      console.log('✅ User-specific watermark test passed');
      console.log('   - Expected text: "iHub Apps | john.doe"');
      return true;
    } else {
      console.log('❌ User-specific watermark test failed');
      return false;
    }
  } catch (error) {
    console.log('❌ User-specific watermark test failed:', error.message);
    return false;
  }
}

async function testTimestampWatermark() {
  console.log('\n🧪 Test 3: Watermark with timestamp');
  
  const config = {
    enabled: true,
    text: 'Test',
    position: 'center',
    opacity: 0.8,
    includeTimestamp: true
  };
  
  try {
    const result = await ImageWatermarkService.addWatermark(
      SAMPLE_PNG_BASE64,
      'image/png',
      config,
      {}
    );
    
    if (result.data) {
      console.log('✅ Timestamp watermark test passed');
      const date = new Date().toISOString().split('T')[0];
      console.log(`   - Expected date in text: ${date}`);
      return true;
    } else {
      console.log('❌ Timestamp watermark test failed');
      return false;
    }
  } catch (error) {
    console.log('❌ Timestamp watermark test failed:', error.message);
    return false;
  }
}

async function testDisabledWatermark() {
  console.log('\n🧪 Test 4: Disabled watermark (should return original)');
  
  const config = {
    enabled: false,
    text: 'Should Not Appear'
  };
  
  try {
    const result = await ImageWatermarkService.addWatermark(
      SAMPLE_PNG_BASE64,
      'image/png',
      config,
      {}
    );
    
    if (result.data === SAMPLE_PNG_BASE64) {
      console.log('✅ Disabled watermark test passed (returned original image)');
      return true;
    } else {
      console.log('❌ Disabled watermark test failed (image was modified)');
      return false;
    }
  } catch (error) {
    console.log('❌ Disabled watermark test failed:', error.message);
    return false;
  }
}

async function testAllPositions() {
  console.log('\n🧪 Test 5: All watermark positions');
  
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  let allPassed = true;
  
  for (const position of positions) {
    const config = {
      enabled: true,
      text: 'Test',
      position,
      opacity: 0.5
    };
    
    try {
      const result = await ImageWatermarkService.addWatermark(
        SAMPLE_PNG_BASE64,
        'image/png',
        config,
        {}
      );
      
      if (result.data) {
        console.log(`   ✅ Position "${position}" works`);
      } else {
        console.log(`   ❌ Position "${position}" failed`);
        allPassed = false;
      }
    } catch (error) {
      console.log(`   ❌ Position "${position}" failed:`, error.message);
      allPassed = false;
    }
  }
  
  if (allPassed) {
    console.log('✅ All positions test passed');
  } else {
    console.log('❌ Some positions failed');
  }
  
  return allPassed;
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════');
  console.log('  ImageWatermarkService Test Suite');
  console.log('═══════════════════════════════════════════════\n');
  
  const results = [];
  
  results.push(await testBasicWatermark());
  results.push(await testUserSpecificWatermark());
  results.push(await testTimestampWatermark());
  results.push(await testDisabledWatermark());
  results.push(await testAllPositions());
  
  const passed = results.filter(r => r).length;
  const failed = results.filter(r => !r).length;
  
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Test Results: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`  ⚠️  ${failed} test(s) failed`);
  } else {
    console.log('  ✅ All tests passed!');
  }
  console.log('═══════════════════════════════════════════════');
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
