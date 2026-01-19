/**
 * Demonstration of the Anthropic tool name fix
 * This shows how tools are properly converted from localized names to Anthropic format
 */

import { convertGenericToolsToAnthropic } from '../adapters/toolCalling/AnthropicConverter.js';

console.log('═══════════════════════════════════════════════════════');
console.log('  Anthropic Tool Name Validation Fix - Demonstration');
console.log('═══════════════════════════════════════════════════════\n');

// Simulating tools as they appear after localization in German
const toolsAfterLocalization = [
  {
    id: 'webContentExtractor',
    name: 'Web-Inhalts-Extraktor',
    description:
      'Extrahieren Sie saubere, lesbare Inhalte von einer URL. Dies können Inhalte wie PDFs oder Webseiten sein, wobei Werbung, Kopfzeilen, Fußzeilen und andere Nicht-Inhaltselemente entfernt werden.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Die vollständige URL der Webseite, von der Inhalte extrahiert werden sollen.'
        }
      },
      required: ['url']
    }
  },
  {
    id: 'enhancedWebSearch',
    name: 'Erweiterte Websuche mit Inhalten',
    description:
      'Führt eine Websuche durch und extrahiert automatisch vollständige Inhalte aus den Top-Ergebnissen für umfassende Informationsbeschaffung.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Die Suchanfrage oder Suchbegriffe für die Websuche.'
        }
      },
      required: ['query']
    }
  }
];

console.log('📥 BEFORE FIX - Localized Tools (German):');
console.log('─'.repeat(70));
toolsAfterLocalization.forEach((tool, i) => {
  console.log(`\nTool ${i + 1}:`);
  console.log(`  ID:   "${tool.id}"`);
  console.log(`  Name: "${tool.name}"`);
  console.log(
    `  Valid for Anthropic: ${/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) ? '✓' : '✗ (contains spaces/special chars)'}`
  );
});

console.log('\n\n📤 AFTER FIX - Converted to Anthropic Format:');
console.log('─'.repeat(70));

const anthropicTools = convertGenericToolsToAnthropic(toolsAfterLocalization);
anthropicTools.forEach((tool, i) => {
  console.log(`\nTool ${i + 1}:`);
  console.log(`  name: "${tool.name}"`);
  console.log(
    `  Valid for Anthropic: ${/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) ? '✓ YES' : '✗ NO'}`
  );
  console.log(`  description: "${tool.description.substring(0, 60)}..."`);
});

console.log('\n\n🔍 VERIFICATION:');
console.log('─'.repeat(70));

const allValid = anthropicTools.every(tool => /^[a-zA-Z0-9_-]{1,128}$/.test(tool.name));

if (allValid) {
  console.log('✅ All tool names are valid for Anthropic API!');
  console.log('✅ The fix successfully converts localized names to valid identifiers');
  console.log('✅ Using tool.id instead of tool.name prevents validation errors');
} else {
  console.log('❌ Some tool names are still invalid!');
}

console.log('\n\n📋 ANTHROPIC API REQUEST EXAMPLE:');
console.log('─'.repeat(70));
console.log(
  JSON.stringify(
    {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'user',
          content: 'wer ist die intrafind?'
        }
      ],
      tools: anthropicTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      })),
      max_tokens: 1024
    },
    null,
    2
  )
);

console.log('\n═══════════════════════════════════════════════════════');
console.log('  ✓ Demonstration Complete');
console.log('═══════════════════════════════════════════════════════');
