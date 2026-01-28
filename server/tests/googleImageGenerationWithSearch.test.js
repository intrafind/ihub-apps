/**
 * Test to verify that image generation works with google_search tool
 * This test validates the fix for the issue where images were not being
 * returned when using google_search with image generation models
 */

import assert from 'assert';
import { convertGoogleResponseToGeneric } from '../adapters/toolCalling/GoogleConverter.js';

console.log('Testing Google Image Generation with google_search...');

// Minimal 1x1 pixel PNG for testing (base64-encoded)
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Test 1: Verify that image data is properly extracted from Google's response
// This simulates a response from Gemini with image generation and google_search
const imageResponse = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: 'Here is an image showing the IntraFind Software AG from Munich:'
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: TEST_IMAGE_BASE64
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0,
      safetyRatings: []
    }
  ],
  groundingMetadata: {
    searchEntryPoint: {
      renderedContent: '<chunk>IntraFind Software AG is a company based in Munich...</chunk>'
    },
    groundingSupports: [
      {
        segment: {
          startIndex: 0,
          endIndex: 50
        },
        groundingChunkIndices: [0],
        confidenceScores: [0.95]
      }
    ]
  }
};

const result1 = convertGoogleResponseToGeneric(JSON.stringify(imageResponse), 'google');

// Verify text content is extracted
assert.ok(result1.content.length > 0, 'Should have text content');
assert.ok(result1.content[0].includes('IntraFind'), 'Text content should be about IntraFind');

// Verify image is extracted
assert.ok(result1.images, 'Should have images array');
assert.strictEqual(result1.images.length, 1, 'Should have exactly 1 image');
assert.strictEqual(result1.images[0].mimeType, 'image/png', 'Image should be PNG');
assert.ok(result1.images[0].data, 'Image should have base64 data');

// Verify grounding metadata is extracted
assert.ok(result1.groundingMetadata, 'Should have grounding metadata');
assert.ok(
  result1.groundingMetadata.searchEntryPoint,
  'Should have search entry point in grounding metadata'
);

// Verify completion status
assert.strictEqual(result1.complete, true, 'Response should be marked as complete');
assert.strictEqual(result1.finishReason, 'stop', 'Finish reason should be stop');

console.log('✓ Test 1: Image extraction from response with google_search works correctly');

// Test 2: Verify that thought images are filtered out (only final images shown)
const responseWithThoughtImage = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: 'Planning the image...',
            thought: true
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'thought-image-data'
            },
            thought: true // This should be filtered out
          },
          {
            text: 'Here is the final image:'
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'final-image-data'
            }
            // thought is not set or false - this should be included
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0
    }
  ]
};

const result2 = convertGoogleResponseToGeneric(JSON.stringify(responseWithThoughtImage), 'google');

// Verify only non-thought content is included
assert.strictEqual(result2.content.length, 1, 'Should have 1 text content (non-thought)');
assert.ok(result2.content[0].includes('final image'), 'Should have final image text');

// Verify only non-thought image is included
assert.strictEqual(result2.images.length, 1, 'Should have exactly 1 image (non-thought)');
assert.strictEqual(
  result2.images[0].data,
  'final-image-data',
  'Should only include final image, not thought image'
);

// Verify thinking content is extracted
assert.ok(result2.thinking, 'Should have thinking array');
assert.strictEqual(result2.thinking.length, 1, 'Should have 1 thinking content');
assert.ok(result2.thinking[0].includes('Planning'), 'Should have planning thought');

console.log('✓ Test 2: Thought images are correctly filtered out');

// Test 3: Streaming response with images
const streamingImageChunk1 = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: 'Generating image...'
          }
        ],
        role: 'model'
      }
    }
  ]
};

const streamingImageChunk2 = {
  candidates: [
    {
      content: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: 'streaming-image-data'
            }
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP'
    }
  ]
};

const chunk1Result = convertGoogleResponseToGeneric(JSON.stringify(streamingImageChunk1), 'google');
const chunk2Result = convertGoogleResponseToGeneric(JSON.stringify(streamingImageChunk2), 'google');

assert.strictEqual(chunk1Result.content.length, 1, 'First chunk should have text');
assert.ok(
  !chunk1Result.images || chunk1Result.images.length === 0,
  'First chunk should have no images'
);

assert.ok(
  chunk2Result.images && chunk2Result.images.length === 1,
  'Second chunk should have 1 image'
);
assert.strictEqual(chunk2Result.images[0].mimeType, 'image/jpeg', 'Image should be JPEG');
assert.strictEqual(chunk2Result.complete, true, 'Second chunk should be complete');

console.log('✓ Test 3: Streaming image responses work correctly');

// Test 4: Response with google_search but no images (text only)
const textOnlyWithSearch = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: 'Based on my search, IntraFind Software AG is a Munich-based company specializing in enterprise search solutions.'
          }
        ],
        role: 'model'
      },
      finishReason: 'STOP',
      index: 0
    }
  ],
  groundingMetadata: {
    searchEntryPoint: {
      renderedContent: '<chunk>IntraFind information...</chunk>'
    }
  }
};

const result4 = convertGoogleResponseToGeneric(JSON.stringify(textOnlyWithSearch), 'google');

assert.strictEqual(result4.content.length, 1, 'Should have text content');
assert.ok(!result4.images || result4.images.length === 0, 'Should have no images');
assert.ok(result4.groundingMetadata, 'Should have grounding metadata');
assert.strictEqual(result4.complete, true, 'Should be complete');

console.log('✓ Test 4: Text-only response with google_search works correctly');

console.log('\n✅ All tests passed! Image generation with google_search is working correctly.');
