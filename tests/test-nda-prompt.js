import configCache from './server/configCache.js';
import { getLocalizedContent } from './shared/localize.js';

console.log('Testing NDA Risk Analyzer prompt construction...\n');

// Initialize config
await configCache.initialize();

// Get app config
const { data: apps } = configCache.getApps();
const appConfig = apps.find(app => app.id === 'nda-risk-analyzer');

console.log('=== ENGLISH MODE ===\n');
const systemPromptEN = getLocalizedContent(appConfig.system, 'en');
console.log('System Prompt (first 500 chars):');
console.log(systemPromptEN.substring(0, 500));
console.log('\n...\n');

const customRulesVar = appConfig.variables.find(v => v.name === 'custom_rules');
const defaultRulesEN = getLocalizedContent(customRulesVar.defaultValue, 'en');
console.log('\nDefault Custom Rules:');
console.log(defaultRulesEN);

console.log('\n\n=== GERMAN MODE ===\n');
const systemPromptDE = getLocalizedContent(appConfig.system, 'de');
console.log('System Prompt (first 500 chars):');
console.log(systemPromptDE.substring(0, 500));
console.log('\n...\n');

const defaultRulesDE = getLocalizedContent(customRulesVar.defaultValue, 'de');
console.log('\nDefault Custom Rules:');
console.log(defaultRulesDE);

console.log('\n\n=== CHECKING FOR DUPLICATION ===\n');

// Check if English system prompt contains German words
const germanWords = ['Gegenseitigkeit', 'Gegenstand der Zusammenarbeit', 'Dauer des NDA'];
const englishWords = ['Mutuality', 'Cooperation Subject', 'Duration'];

let issuesFound = false;

console.log('English system prompt check:');
germanWords.forEach(word => {
  if (systemPromptEN.includes(word)) {
    console.log(`  ❌ ERROR: English prompt contains German word: "${word}"`);
    issuesFound = true;
  }
});
if (!issuesFound) console.log('  ✓ No German words found in English prompt');

issuesFound = false;
console.log('\nGerman system prompt check:');
englishWords.forEach(word => {
  if (systemPromptDE.includes(word)) {
    console.log(`  ❌ ERROR: German prompt contains English word: "${word}"`);
    issuesFound = true;
  }
});
if (!issuesFound) console.log('  ✓ No English words found in German prompt');

console.log('\n=== OUTPUT SCHEMA ===\n');
console.log('Schema description for clauses:');
console.log(appConfig.outputSchema.properties.clause.description);

process.exit(0);
