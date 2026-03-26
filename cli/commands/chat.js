/**
 * ihub chat — Interactive chat with AI apps via CLI
 * Usage: ihub chat <app-id> [options]
 * Supports both local and remote instances with SSE streaming
 */
import { c, symbols } from '../utils/colors.js';
import { parseServerArgs, getServerUrl } from '../utils/api.js';
import {
  parseRemoteArgs,
  isRemoteMode,
  remoteRequest,
  getDisplayUrl
} from '../utils/remote-api.js';
import { EventSource } from 'eventsource';
import { createInterface } from 'readline';

const HELP = `
  ${c.bold('ihub chat')} — Interactive chat with AI applications

  ${c.bold('Usage:')}
    ihub chat <app-id> [options]

  ${c.bold('Arguments:')}
    app-id               ID of the app to chat with

  ${c.bold('Options:')}
    --model <id>         Override app's default model
    --temperature <n>    Set temperature (0-2, default: from app)
    --format <format>    Output format (markdown|text|json|html)
    --history <n>        Number of messages to keep in context (default: 20)
    --no-stream          Disable streaming (wait for full response)

  ${c.bold('Local Options:')}
    --port <port>        Server port (default: 3000)
    --host <host>        Server host (default: localhost)

  ${c.bold('Remote Options:')}
    --url <url>          Remote instance URL
    --token <token>      Authentication token
    --instance <name>    Use saved remote instance

  ${c.bold('Commands in Chat:')}
    /help                Show available commands
    /clear               Clear conversation history
    /model <id>          Switch to different model
    /temperature <n>     Change temperature
    /history             Show conversation history
    /save <file>         Save conversation to file
    /exit, /quit         Exit chat

  ${c.bold('Examples:')}
    ihub chat assistant
    ihub chat assistant --model gpt-4o
    ihub chat assistant --url https://ihub.example.com --token abc123
    ihub chat assistant --instance prod
`;

/**
 * Parse SSE data stream
 */
function parseSSEChunk(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Stream chat response using EventSource (SSE)
 */
async function streamChatResponse(url, endpoint, body, token, onChunk, onError, onDone) {
  const fullUrl = `${url}${endpoint}`;

  // For SSE, we need to send the message data via query params or use POST with different approach
  // iHub uses POST with EventSource, need to handle this differently

  // Make POST request and handle SSE response
  const response = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    onError(new Error(`Request failed: ${response.status} - ${errorText}`));
    return;
  }

  // Read the stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        onDone();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            onDone();
            return;
          }

          const chunk = parseSSEChunk(data);
          if (chunk) {
            onChunk(chunk);
          }
        }
      }
    }
  } catch (error) {
    onError(error);
  }
}

/**
 * Format and print a chat message
 */
function printMessage(role, content, { streaming = false, color = true } = {}) {
  const roleColors = {
    user: c.cyan,
    assistant: c.green,
    system: c.gray
  };

  const roleColor = color && roleColors[role] ? roleColors[role] : (text => text);
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  if (!streaming) {
    console.log('');
    console.log(roleColor(`${roleLabel}:`));
    console.log(content);
    console.log('');
  } else {
    // For streaming, just print the content incrementally
    process.stdout.write(content);
  }
}

/**
 * Main chat loop
 */
async function chatLoop(
  baseUrl,
  appId,
  {
    modelId = null,
    temperature = null,
    outputFormat = null,
    maxHistory = 20,
    streaming = true,
    token = null
  } = {}
) {
  const messages = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan('You: ')
  });

  console.log('');
  console.log(`${symbols.success} Connected to app: ${c.bold(appId)}`);
  console.log(`  ${c.gray('Type your message or /help for commands')}`);
  console.log('');

  // Handle special commands
  async function handleCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        console.log('');
        console.log(`  ${c.bold('Available Commands:')}`);
        console.log(`  ${c.gray('─'.repeat(40))}`);
        console.log(`  /help                Show this help`);
        console.log(`  /clear               Clear conversation history`);
        console.log(`  /model <id>          Switch to different model`);
        console.log(`  /temperature <n>     Change temperature (0-2)`);
        console.log(`  /history             Show conversation history`);
        console.log(`  /save <file>         Save conversation to file`);
        console.log(`  /exit, /quit         Exit chat`);
        console.log('');
        return true;

      case 'clear':
        messages.length = 0;
        console.log(`${symbols.success} Conversation history cleared`);
        console.log('');
        return true;

      case 'model':
        if (args.length === 0) {
          console.log(`${symbols.error} Usage: /model <model-id>`);
        } else {
          modelId = args[0];
          console.log(`${symbols.success} Switched to model: ${modelId}`);
        }
        console.log('');
        return true;

      case 'temperature':
        if (args.length === 0) {
          console.log(`${symbols.error} Usage: /temperature <0-2>`);
        } else {
          const temp = parseFloat(args[0]);
          if (isNaN(temp) || temp < 0 || temp > 2) {
            console.log(`${symbols.error} Temperature must be between 0 and 2`);
          } else {
            temperature = temp;
            console.log(`${symbols.success} Temperature set to: ${temperature}`);
          }
        }
        console.log('');
        return true;

      case 'history':
        console.log('');
        console.log(`  ${c.bold('Conversation History')} (${messages.length} messages)`);
        console.log(`  ${c.gray('─'.repeat(40))}`);
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const label = `${i + 1}. ${msg.role}`;
          const preview = msg.content.slice(0, 60) + (msg.content.length > 60 ? '...' : '');
          console.log(`  ${c.gray(label)}: ${preview}`);
        }
        console.log('');
        return true;

      case 'save':
        if (args.length === 0) {
          console.log(`${symbols.error} Usage: /save <filename>`);
        } else {
          const filename = args[0];
          try {
            const { writeFileSync } = await import('fs');
            const content = messages
              .map(m => `**${m.role.toUpperCase()}**:\n${m.content}\n`)
              .join('\n---\n\n');
            writeFileSync(filename, content, 'utf-8');
            console.log(`${symbols.success} Conversation saved to: ${filename}`);
          } catch (error) {
            console.error(`${symbols.error} Failed to save: ${error.message}`);
          }
        }
        console.log('');
        return true;

      case 'exit':
      case 'quit':
        console.log('');
        console.log(`${symbols.info} Goodbye!`);
        rl.close();
        process.exit(0);
        return true;

      default:
        console.log(`${symbols.error} Unknown command: /${cmd}`);
        console.log(`  Type ${c.cyan('/help')} for available commands`);
        console.log('');
        return true;
    }
  }

  // Process user input
  async function processInput(input) {
    input = input.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (input.startsWith('/')) {
      await handleCommand(input);
      rl.prompt();
      return;
    }

    // Add user message to history
    messages.push({ role: 'user', content: input });

    // Truncate history if needed
    while (messages.length > maxHistory) {
      messages.shift();
    }

    // Build request body
    const requestBody = {
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    };

    if (modelId) requestBody.modelId = modelId;
    if (temperature !== null) requestBody.temperature = temperature;
    if (outputFormat) requestBody.outputFormat = outputFormat;

    // Generate a chat ID (simplified)
    const chatId = `cli-${Date.now()}`;
    const endpoint = `/api/apps/${appId}/chat/${chatId}`;

    try {
      if (streaming) {
        // Stream the response
        console.log('');
        console.log(c.green('Assistant: '));

        let assistantMessage = '';

        await streamChatResponse(
          baseUrl,
          endpoint,
          requestBody,
          token,
          chunk => {
            if (chunk.content) {
              process.stdout.write(chunk.content);
              assistantMessage += chunk.content;
            }
          },
          error => {
            console.error('');
            console.error(`${symbols.error} ${error.message}`);
          },
          () => {
            console.log('');
            console.log('');

            // Add assistant message to history
            if (assistantMessage) {
              messages.push({ role: 'assistant', content: assistantMessage });
            }

            rl.prompt();
          }
        );
      } else {
        // Non-streaming request
        const response = await remoteRequest(baseUrl, endpoint, {
          method: 'POST',
          body: JSON.stringify(requestBody)
        }, { token });

        const data = await response.json();

        if (data.content) {
          printMessage('assistant', data.content);
          messages.push({ role: 'assistant', content: data.content });
        }

        rl.prompt();
      }
    } catch (error) {
      console.error('');
      console.error(`${symbols.error} ${error.message}`);
      console.error('');
      rl.prompt();
    }
  }

  // Start the chat loop
  rl.on('line', processInput);
  rl.on('close', () => {
    console.log('');
    console.log(`${symbols.info} Goodbye!`);
    process.exit(0);
  });

  // Initial prompt
  rl.prompt();
}

export default async function chat(args) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(HELP);
    if (args.length === 0) {
      console.error(`${symbols.error} Usage: ihub chat <app-id>`);
      process.exit(1);
    }
    return;
  }

  // Parse remote and local args
  const remoteArgs = parseRemoteArgs(args);
  const isRemote = isRemoteMode(remoteArgs);

  let baseUrl, token, appId;
  let modelId = null;
  let temperature = null;
  let outputFormat = null;
  let maxHistory = 20;
  let streaming = !args.includes('--no-stream');

  if (isRemote) {
    baseUrl = remoteArgs.url;
    token = remoteArgs.token;
  } else {
    const { port, host } = parseServerArgs(remoteArgs.remainingArgs);
    baseUrl = getServerUrl(port, host);
    token = null;
  }

  // Parse remaining arguments
  const remainingArgs = isRemote ? remoteArgs.remainingArgs : args;

  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];

    if (arg === '--model' && remainingArgs[i + 1]) {
      modelId = remainingArgs[i + 1];
      i++;
    } else if (arg.startsWith('--model=')) {
      modelId = arg.split('=')[1];
    } else if (arg === '--temperature' && remainingArgs[i + 1]) {
      temperature = parseFloat(remainingArgs[i + 1]);
      i++;
    } else if (arg.startsWith('--temperature=')) {
      temperature = parseFloat(arg.split('=')[1]);
    } else if (arg === '--format' && remainingArgs[i + 1]) {
      outputFormat = remainingArgs[i + 1];
      i++;
    } else if (arg.startsWith('--format=')) {
      outputFormat = arg.split('=')[1];
    } else if (arg === '--history' && remainingArgs[i + 1]) {
      maxHistory = parseInt(remainingArgs[i + 1], 10);
      i++;
    } else if (arg.startsWith('--history=')) {
      maxHistory = parseInt(arg.split('=')[1], 10);
    } else if (!arg.startsWith('--')) {
      appId = arg;
    }
  }

  if (!appId) {
    console.error(`${symbols.error} No app ID specified`);
    console.error(`  Usage: ihub chat <app-id>`);
    process.exit(1);
  }

  console.log(`${symbols.info} Connecting to ${isRemote ? c.cyan(getDisplayUrl(baseUrl)) : 'local instance'}...`);

  // Start chat loop
  await chatLoop(baseUrl, appId, {
    modelId,
    temperature,
    outputFormat,
    maxHistory,
    streaming,
    token
  });
}
