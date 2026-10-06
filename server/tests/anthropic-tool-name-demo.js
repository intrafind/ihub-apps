/**
 * Demonstration of the Anthropic tool name fix
 * This shows how tools are properly converted from localized names to Anthropic format
 */

import { convertGenericToolsToAnthropic } from '../adapters/toolCalling/AnthropicConverter.js';
import logger from '../utils/logger.js';

logger.info('═══════════════════════════════════════════════════════');
logger.info('  Anthropic Tool Name Validation Fix - Demonstration');
logger.info('═══════════════════════════════════════════════════════\n');

// Simulating tools as they appear after localization in German
const toolsAfterLocalization = [
  {
    id: 'read_url',
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

logger.info('📥 BEFORE FIX - Localized Tools (German):');
logger.info('─'.repeat(70));
toolsAfterLocalization.forEach((tool, i) => {
  logger.info(`\nTool ${i + 1}:`);
  logger.info(`  ID:   "${tool.id}"`);
  logger.info(`  Name: "${tool.name}"`);
  logger.info(
    `  Valid for Anthropic: ${/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) ? '✓' : '✗ (contains spaces/special chars)'}`
  );
});

logger.info('\n\n📤 AFTER FIX - Converted to Anthropic Format:');
logger.info('─'.repeat(70));

const anthropicTools = convertGenericToolsToAnthropic(toolsAfterLocalization);
anthropicTools.forEach((tool, i) => {
  logger.info(`\nTool ${i + 1}:`);
  logger.info(`  name: "${tool.name}"`);
  logger.info(
    `  Valid for Anthropic: ${/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) ? '✓ YES' : '✗ NO'}`
  );
  logger.info(`  description: "${tool.description.substring(0, 60)}..."`);
});

logger.info('\n\n🔍 VERIFICATION:');
logger.info('─'.repeat(70));

const allValid = anthropicTools.every(tool => /^[a-zA-Z0-9_-]{1,128}$/.test(tool.name));

if (allValid) {
  logger.info('✅ All tool names are valid for Anthropic API!');
  logger.info('✅ The fix successfully converts localized names to valid identifiers');
  logger.info('✅ Using tool.id instead of tool.name prevents validation errors');
} else {
  logger.info('❌ Some tool names are still invalid!');
}

logger.info('\n\n📋 ANTHROPIC API REQUEST EXAMPLE:');
logger.info('─'.repeat(70));
logger.info(
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

logger.info('\n═══════════════════════════════════════════════════════');
logger.info('  ✓ Demonstration Complete');
logger.info('═══════════════════════════════════════════════════════');
