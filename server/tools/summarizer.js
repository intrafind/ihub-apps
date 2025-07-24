import { TokenCounter } from '../utils/TokenCounter.js';

/**
 * Universal Summarization Tool
 * Provides intelligent summarization capabilities for all apps
 * Handles token-aware summarization with multiple output formats
 */

/**
 * Main summarizer function
 * @param {Object} params - Tool parameters
 * @param {Object} context - Execution context
 * @returns {Object} Summarization result
 */
export default async function summarizer(params, context) {
  const { 
    content, 
    targetLength = 500, 
    style = 'paragraph', 
    focus,
    preserveStructure = false,
    compressionRatio 
  } = params;
  
  const { actionTracker, appConfig, chatService } = context;
  
  if (!content) {
    throw new Error('Content parameter is required for summarization');
  }
  
  try {
    actionTracker?.reportProgress('📊 Analyzing content for summarization...');
    
    // Determine model family from current context
    const modelFamily = context.modelConfig?.tokenFamily || 'gpt-4';
    
    // Check if content needs summarization
    const originalTokens = TokenCounter.countTokens(content, modelFamily);
    
    if (originalTokens <= targetLength) {
      actionTracker?.reportProgress('✅ Content already within target length');
      return {
        summary: content,
        originalTokens,
        summaryTokens: originalTokens,
        compressionRatio: 1.0,
        summarized: false,
        style,
        method: 'no_summarization_needed'
      };
    }
    
    // Determine summarization approach based on content size
    const approachResult = await determineSummarizationApproach(content, targetLength, originalTokens);
    actionTracker?.reportProgress(`📝 Using ${approachResult.method} approach`);
    
    let summary;
    let method = approachResult.method;
    
    switch (approachResult.method) {
      case 'direct':
        summary = await directSummarization(content, targetLength, style, focus, context);
        break;
      case 'hierarchical':
        summary = await hierarchicalSummarization(content, targetLength, style, focus, context);
        break;
      case 'extractive':
        summary = await extractiveSummarization(content, targetLength, style, focus, context);
        break;
      default:
        summary = await directSummarization(content, targetLength, style, focus, context);
        method = 'direct';
    }
    
    const summaryTokens = TokenCounter.countTokens(summary, modelFamily);
    const actualCompressionRatio = summaryTokens / originalTokens;
    
    actionTracker?.reportProgress('✅ Summarization complete');
    
    return {
      summary,
      originalTokens,
      summaryTokens,
      compressionRatio: Math.round(actualCompressionRatio * 100) / 100,
      summarized: true,
      style,
      focus: focus || 'general',
      method,
      targetLength,
      efficiency: calculateEfficiency(originalTokens, summaryTokens, targetLength)
    };
    
  } catch (error) {
    actionTracker?.reportProgress(`❌ Summarization failed: ${error.message}`);
    throw new Error(`Summarization failed: ${error.message}`);
  }
}

/**
 * Determine the best summarization approach based on content characteristics
 */
async function determineSummarizationApproach(content, targetLength, originalTokens) {
  const contentLength = content.length;
  const compressionNeeded = originalTokens / targetLength;
  
  // Check content structure
  const hasStructure = detectStructure(content);
  const complexity = assessComplexity(content);
  
  if (compressionNeeded <= 3 && !hasStructure.isComplex) {
    return { method: 'direct', reason: 'Simple content with low compression needed' };
  } else if (compressionNeeded > 10 || hasStructure.isComplex) {
    return { method: 'hierarchical', reason: 'Complex content or high compression needed' };
  } else if (hasStructure.hasLists || hasStructure.hasSections) {
    return { method: 'extractive', reason: 'Structured content suitable for extraction' };
  } else {
    return { method: 'direct', reason: 'Standard summarization approach' };
  }
}

/**
 * Direct summarization using LLM
 */
async function directSummarization(content, targetLength, style, focus, context) {
  const prompt = buildSummarizationPrompt(content, targetLength, style, focus);
  return await callLLMForSummarization(prompt, context);
}

/**
 * Hierarchical summarization for very large content
 */
async function hierarchicalSummarization(content, targetLength, style, focus, context) {
  const { actionTracker } = context;
  
  // Split content into manageable chunks
  const chunks = chunkContent(content, 4000); // ~4000 token chunks
  actionTracker?.reportProgress(`📄 Processing ${chunks.length} content chunks`);
  
  if (chunks.length === 1) {
    return await directSummarization(content, targetLength, style, focus, context);
  }
  
  // Summarize each chunk
  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    actionTracker?.reportProgress(`Processing chunk ${i + 1}/${chunks.length}`);
    
    const chunkTargetLength = Math.ceil(targetLength * 0.6 / chunks.length); // Leave room for final synthesis
    const chunkPrompt = buildSummarizationPrompt(chunks[i], chunkTargetLength, 'paragraph', focus);
    const chunkSummary = await callLLMForSummarization(chunkPrompt, context);
    chunkSummaries.push(chunkSummary);
  }
  
  // Synthesize chunk summaries into final summary
  actionTracker?.reportProgress('🔄 Synthesizing final summary');
  const combinedSummaries = chunkSummaries.join('\n\n');
  const finalPrompt = buildSynthesisPrompt(combinedSummaries, targetLength, style, focus);
  
  return await callLLMForSummarization(finalPrompt, context);
}

/**
 * Extractive summarization focusing on key sections
 */
async function extractiveSummarization(content, targetLength, style, focus, context) {
  const { actionTracker } = context;
  
  actionTracker?.reportProgress('🔍 Identifying key sections');
  
  // Extract key sections based on structure and importance
  const sections = extractKeySections(content, focus);
  
  if (sections.length === 0) {
    return await directSummarization(content, targetLength, style, focus, context);
  }
  
  // Prioritize sections and fit within target length
  const prioritizedSections = prioritizeSections(sections, targetLength);
  const extractedContent = prioritizedSections.map(s => s.content).join('\n\n');
  
  // Apply final summarization if still too long
  const modelFamily = context.modelConfig?.tokenFamily || 'gpt-4';
  const extractedTokens = TokenCounter.countTokens(extractedContent, modelFamily);
  
  if (extractedTokens <= targetLength) {
    return formatExtractedContent(prioritizedSections, style);
  } else {
    actionTracker?.reportProgress('🔄 Applying final compression');
    return await directSummarization(extractedContent, targetLength, style, focus, context);
  }
}

/**
 * Build summarization prompt based on parameters
 */
function buildSummarizationPrompt(content, targetLength, style, focus) {
  let prompt = `Please provide a comprehensive summary of the following content.\n\n`;
  
  // Add target length guidance
  prompt += `Target length: approximately ${targetLength} tokens\n`;
  
  // Add style instructions
  switch (style) {
    case 'bullet':
      prompt += `Format: Use bullet points to organize key information\n`;
      break;
    case 'paragraph':
      prompt += `Format: Use well-structured paragraphs\n`;
      break;
    case 'detailed':
      prompt += `Format: Provide detailed analysis with subheadings where appropriate\n`;
      break;
  }
  
  // Add focus instructions
  if (focus) {
    prompt += `Focus: Pay special attention to aspects related to "${focus}"\n`;
  }
  
  prompt += `\nRequirements:
- Preserve the most important information and key insights
- Maintain factual accuracy
- Use clear, concise language
- Ensure the summary is self-contained and coherent
- Stay within the target length while maximizing information density\n\n`;
  
  prompt += `Content to summarize:\n${content}`;
  
  return prompt;
}

/**
 * Build synthesis prompt for combining chunk summaries
 */
function buildSynthesisPrompt(combinedSummaries, targetLength, style, focus) {
  let prompt = `Please synthesize the following section summaries into a single, coherent summary.\n\n`;
  
  prompt += `Target length: approximately ${targetLength} tokens\n`;
  prompt += `Format: ${style === 'bullet' ? 'bullet points' : 'paragraphs'}\n`;
  
  if (focus) {
    prompt += `Focus: Emphasize aspects related to "${focus}"\n`;
  }
  
  prompt += `\nRequirements:
- Eliminate redundancy between sections
- Maintain logical flow and coherence
- Preserve the most critical information from each section
- Create a unified narrative that represents the entire content\n\n`;
  
  prompt += `Section summaries to synthesize:\n${combinedSummaries}`;
  
  return prompt;
}

/**
 * Call LLM for summarization using the current context
 */
async function callLLMForSummarization(prompt, context) {
  const { chatService, modelConfig, apiKey } = context;
  
  // Prepare messages for LLM call
  const messages = [
    {
      role: 'user',
      content: prompt
    }
  ];
  
  // Use the chat service to call the LLM
  try {
    const response = await chatService.callLLM(messages, modelConfig, apiKey, {
      temperature: 0.3, // Lower temperature for more consistent summaries
      maxTokens: Math.min(4096, modelConfig.maxOutputTokens || 4096)
    });
    
    return response.content || response.message || '';
  } catch (error) {
    throw new Error(`LLM call failed: ${error.message}`);
  }
}

/**
 * Detect content structure
 */
function detectStructure(content) {
  const hasHeadings = /^#+\s/m.test(content) || /^[A-Z][A-Za-z\s]+:$/m.test(content);
  const hasLists = /^\s*[-*+]\s/m.test(content) || /^\s*\d+\.\s/m.test(content);
  const hasSections = content.split('\n\n').length > 5;
  const hasCodeBlocks = /```/.test(content);
  const hasTables = /\|.*\|/.test(content);
  
  return {
    hasHeadings,
    hasLists,
    hasSections,
    hasCodeBlocks,
    hasTables,
    isComplex: hasHeadings || hasCodeBlocks || hasTables || (hasLists && hasSections)
  };
}

/**
 * Assess content complexity
 */
function assessComplexity(content) {
  const sentences = content.split(/[.!?]+/).length;
  const avgSentenceLength = content.length / sentences;
  const uniqueWords = new Set(content.toLowerCase().match(/\w+/g) || []).size;
  const totalWords = (content.match(/\w+/g) || []).length;
  const vocabularyRichness = uniqueWords / totalWords;
  
  return {
    sentences,
    avgSentenceLength,
    vocabularyRichness,
    isComplex: avgSentenceLength > 25 || vocabularyRichness > 0.7
  };
}

/**
 * Chunk content into manageable pieces
 */
function chunkContent(content, maxTokensPerChunk) {
  const paragraphs = content.split('\n\n');
  const chunks = [];
  let currentChunk = '';
  
  for (const paragraph of paragraphs) {
    const testChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
    const tokenCount = TokenCounter.countTokens(testChunk, 'gpt-4'); // Use gpt-4 as default
    
    if (tokenCount > maxTokensPerChunk && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = paragraph;
    } else {
      currentChunk = testChunk;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks.length > 0 ? chunks : [content];
}

/**
 * Extract key sections from structured content
 */
function extractKeySections(content, focus) {
  const sections = [];
  
  // Split by headers or double line breaks
  const parts = content.split(/\n(?=#+\s)|(?:\n\s*\n)/);
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    
    const importance = calculateSectionImportance(part, focus, i, parts.length);
    sections.push({
      content: part,
      importance,
      position: i,
      tokens: TokenCounter.countTokens(part, 'gpt-4')
    });
  }
  
  return sections.sort((a, b) => b.importance - a.importance);
}

/**
 * Calculate section importance score
 */
function calculateSectionImportance(section, focus, position, totalSections) {
  let score = 1.0;
  
  // Position-based scoring (beginning and end are more important)
  if (position === 0) score += 0.5; // First section
  if (position === totalSections - 1) score += 0.3; // Last section
  if (position < totalSections * 0.2) score += 0.2; // Early sections
  
  // Length-based scoring (not too short, not too long)
  const wordCount = section.split(/\s+/).length;
  if (wordCount > 20 && wordCount < 200) score += 0.3;
  
  // Content-based scoring
  if (/^#+\s/.test(section)) score += 0.4; // Has heading
  if (/\b(important|key|critical|essential|summary|conclusion)\b/i.test(section)) score += 0.3;
  if (/\b(example|for instance|such as)\b/i.test(section)) score += 0.1;
  
  // Focus-based scoring
  if (focus && section.toLowerCase().includes(focus.toLowerCase())) {
    score += 1.0;
  }
  
  return score;
}

/**
 * Prioritize sections to fit within target length
 */
function prioritizeSections(sections, targetLength) {
  let totalTokens = 0;
  const selectedSections = [];
  
  for (const section of sections) {
    if (totalTokens + section.tokens <= targetLength * 0.8) { // Leave some margin
      selectedSections.push(section);
      totalTokens += section.tokens;
    }
  }
  
  // Sort back to original order
  return selectedSections.sort((a, b) => a.position - b.position);
}

/**
 * Format extracted content based on style
 */
function formatExtractedContent(sections, style) {
  if (style === 'bullet') {
    return sections.map(s => `• ${s.content.replace(/\n/g, ' ')}`).join('\n');
  } else {
    return sections.map(s => s.content).join('\n\n');
  }
}

/**
 * Calculate summarization efficiency
 */
function calculateEfficiency(originalTokens, summaryTokens, targetLength) {
  const compressionRatio = summaryTokens / originalTokens;
  const targetHit = Math.min(1, targetLength / summaryTokens);
  
  return {
    compressionRatio: Math.round(compressionRatio * 100) / 100,
    targetAccuracy: Math.round(targetHit * 100) / 100,
    overallScore: Math.round(((1 - compressionRatio) + targetHit) * 50) / 100
  };
}

// CLI support for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const testContent = process.argv[2] || "This is a sample text for testing the summarization tool. It contains multiple sentences to demonstrate how the tool works with different types of content.";
  const targetLength = parseInt(process.argv[3]) || 50;
  
  console.log('Testing summarizer tool...');
  console.log('Content:', testContent);
  console.log('Target length:', targetLength);
  
  try {
    const result = await summarizer(
      { content: testContent, targetLength, style: 'paragraph' },
      { 
        actionTracker: { reportProgress: console.log },
        modelConfig: { tokenFamily: 'gpt-4' },
        chatService: {
          callLLM: async () => ({ content: "This is a test summary of the provided content." })
        }
      }
    );
    
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}