/**
 * Basic usage examples for the LLM SDK
 */

import { LLMClient, Message, createSimpleClient } from '../src/index.js';

/**
 * Example 1: Simple chat with OpenAI
 */
async function basicChatExample() {
  console.log('=== Basic Chat Example ===');
  
  // Create a simple client (you would use real API keys)
  const client = createSimpleClient('openai', 'sk-your-openai-api-key-here');
  
  // Wait for initialization
  await client.ready();
  
  try {
    const response = await client.chat({
      model: 'gpt-3.5-turbo',
      messages: [
        Message.system('You are a helpful assistant.'),
        Message.user('What is the capital of France?')
      ],
      temperature: 0.7,
      maxTokens: 100
    });
    
    console.log('Response:', response.content);
    console.log('Usage:', response.usage);
  } catch (error) {
    console.error('Chat failed:', error.message);
  }
}

/**
 * Example 2: Multi-provider setup
 */
async function multiProviderExample() {
  console.log('=== Multi-Provider Example ===');
  
  const client = new LLMClient({
    providers: {
      openai: {
        apiKey: 'sk-your-openai-api-key-here'
      },
      anthropic: {
        apiKey: 'sk-ant-your-anthropic-api-key-here'
      },
      google: {
        apiKey: 'your-google-api-key-here'
      }
    },
    defaultProvider: 'openai'
  });
  
  await client.ready();
  
  // Chat with different providers
  const providers = ['openai', 'anthropic', 'google'];
  
  for (const provider of providers) {
    try {
      console.log(`\n--- Using ${provider} ---`);
      
      const response = await client.chat({
        provider,
        model: provider === 'openai' ? 'gpt-3.5-turbo' : 
               provider === 'anthropic' ? 'claude-3-haiku-20240307' : 
               'gemini-pro',
        messages: [Message.user('Say hello in a creative way')],
        maxTokens: 50
      });
      
      console.log(`${provider.toUpperCase()}:`, response.content);
    } catch (error) {
      console.error(`${provider} failed:`, error.message);
    }
  }
}

/**
 * Example 3: Streaming chat
 */
async function streamingExample() {
  console.log('=== Streaming Example ===');
  
  const client = createSimpleClient('openai', 'sk-your-openai-api-key-here');
  await client.ready();
  
  try {
    const stream = await client.stream({
      model: 'gpt-3.5-turbo',
      messages: [
        Message.user('Tell me a short story about a robot learning to paint.')
      ],
      maxTokens: 200
    });
    
    console.log('Streaming response:');
    let fullResponse = '';
    
    for await (const chunk of stream) {
      if (chunk.content) {
        process.stdout.write(chunk.content);
        fullResponse += chunk.content;
      }
      
      if (chunk.isFinal()) {
        console.log('\n\nStream completed. Final response length:', fullResponse.length);
        break;
      }
    }
  } catch (error) {
    console.error('Streaming failed:', error.message);
  }
}

/**
 * Example 4: Tool calling
 */
async function toolCallingExample() {
  console.log('=== Tool Calling Example ===');
  
  const client = createSimpleClient('openai', 'sk-your-openai-api-key-here');
  await client.ready();
  
  // Define a simple tool
  const tools = [{
    name: 'get_weather',
    description: 'Get the weather for a specific location',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and country, e.g., London, UK'
        },
        unit: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Temperature unit'
        }
      },
      required: ['location']
    }
  }];
  
  try {
    const response = await client.chat({
      model: 'gpt-4',
      messages: [
        Message.user('What\'s the weather like in Paris today?')
      ],
      tools,
      toolChoice: 'auto',
      maxTokens: 200
    });
    
    console.log('Response:', response.content);
    
    if (response.hasToolCalls()) {
      console.log('Tool calls made:');
      for (const toolCall of response.toolCalls) {
        console.log(`- ${toolCall.name}:`, toolCall.arguments);
        
        // Simulate tool execution
        const toolResult = {
          location: toolCall.arguments.location,
          temperature: '22°C',
          condition: 'Sunny',
          humidity: '45%'
        };
        
        console.log('  Result:', toolResult);
      }
    }
  } catch (error) {
    console.error('Tool calling failed:', error.message);
  }
}

/**
 * Example 5: Structured output
 */
async function structuredOutputExample() {
  console.log('=== Structured Output Example ===');
  
  const client = createSimpleClient('openai', 'sk-your-openai-api-key-here');
  await client.ready();
  
  // Define JSON schema for response
  const schema = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Brief summary of the book'
      },
      rating: {
        type: 'number',
        minimum: 1,
        maximum: 5,
        description: 'Rating out of 5'
      },
      genres: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of genres'
      },
      recommended: {
        type: 'boolean',
        description: 'Whether the book is recommended'
      }
    },
    required: ['summary', 'rating', 'genres', 'recommended']
  };
  
  try {
    const response = await client.chat({
      model: 'gpt-4',
      messages: [
        Message.user('Please review the book "The Hitchhiker\'s Guide to the Galaxy" by Douglas Adams')
      ],
      responseFormat: {
        type: 'json_schema',
        schema
      },
      maxTokens: 300
    });
    
    console.log('Structured response:');
    try {
      const parsed = JSON.parse(response.content);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('Raw response:', response.content);
    }
  } catch (error) {
    console.error('Structured output failed:', error.message);
  }
}

/**
 * Example 6: Image processing
 */
async function imageProcessingExample() {
  console.log('=== Image Processing Example ===');
  
  const client = createSimpleClient('openai', 'sk-your-openai-api-key-here');
  await client.ready();
  
  // Example with image URL (you would use a real image URL)
  const imageUrl = 'https://example.com/sample-image.jpg';
  
  try {
    const response = await client.chat({
      model: 'gpt-4-vision-preview',
      messages: [
        Message.userWithImage('What do you see in this image?', imageUrl)
      ],
      maxTokens: 200
    });
    
    console.log('Image analysis:', response.content);
  } catch (error) {
    console.error('Image processing failed:', error.message);
  }
}

/**
 * Example 7: Error handling and provider info
 */
async function errorHandlingExample() {
  console.log('=== Error Handling Example ===');
  
  const client = new LLMClient({
    providers: {
      openai: {
        apiKey: 'invalid-key' // Intentionally invalid
      }
    }
  });
  
  await client.ready();
  
  // Get provider information
  console.log('Available providers:', client.getProviders());
  console.log('Provider info:', client.getProviderInfo('openai'));
  
  // Test provider connection
  const testResult = await client.testProvider('openai');
  console.log('Test result:', testResult);
  
  // Try chat with invalid key
  try {
    await client.chat({
      model: 'gpt-3.5-turbo',
      messages: [Message.user('Hello')]
    });
  } catch (error) {
    console.log('Expected error caught:', error.name, '-', error.message);
  }
}

/**
 * Run all examples
 */
async function runExamples() {
  const examples = [
    basicChatExample,
    multiProviderExample,
    streamingExample,
    toolCallingExample,
    structuredOutputExample,
    imageProcessingExample,
    errorHandlingExample
  ];
  
  for (const example of examples) {
    try {
      await example();
      console.log('\n' + '='.repeat(50) + '\n');
    } catch (error) {
      console.error(`Example ${example.name} failed:`, error);
      console.log('\n' + '='.repeat(50) + '\n');
    }
  }
}

// Export for use in other files
export {
  basicChatExample,
  multiProviderExample,
  streamingExample,
  toolCallingExample,
  structuredOutputExample,
  imageProcessingExample,
  errorHandlingExample
};

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExamples().catch(console.error);
}