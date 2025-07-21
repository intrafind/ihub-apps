// Microsoft Teams Bot Integration for AI Hub Apps
// Uses Microsoft Bot Framework to handle Teams messages and forward them to AI Hub Apps

import { BotFrameworkAdapter, ActivityHandler, MessageFactory, CardFactory } from 'botbuilder';
import config from './config.js';
import { loadAppConfigurations } from './configCache.js';
import { ChatService } from './services/chat/ChatService.js';

/**
 * Teams Bot Handler
 * Processes incoming Teams messages, maps them to AI Hub Apps, and streams responses
 */
class TeamsBot extends ActivityHandler {
  constructor() {
    super();

    this.chatService = new ChatService();

    // Handle incoming messages
    this.onMessage(async (context, next) => {
      await this.handleMessage(context);
      await next();
    });

    // Handle members added (welcome message)
    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      const welcomeText =
        'Welcome to AI Hub Apps! You can ask me to help with various tasks like translation, summarization, code generation, and more. Just describe what you need!';

      for (let cnt = 0; cnt < membersAdded.length; cnt++) {
        if (membersAdded[cnt].id !== context.activity.recipient.id) {
          const welcomeCard = this.createWelcomeCard();
          await context.sendActivity(MessageFactory.attachment(welcomeCard));
        }
      }
      await next();
    });
  }

  /**
   * Handle incoming messages from Teams
   */
  async handleMessage(context) {
    try {
      const userMessage = context.activity.text?.trim();
      if (!userMessage) {
        await context.sendActivity(
          MessageFactory.text('Please send me a message describing what you need help with.')
        );
        return;
      }

      // Show typing indicator
      await context.sendActivity({ type: 'typing' });

      // Map user intent to AI Hub app
      const appId = await this.mapUserIntentToApp(userMessage);

      if (!appId) {
        await context.sendActivity(
          MessageFactory.text(
            'I couldn\'t determine which app to use for your request. Try being more specific, like "translate this text" or "summarize this document".'
          )
        );
        return;
      }

      // Get user information from Teams context
      const user = this.extractUserFromContext(context);

      // Send message to AI Hub chat service
      await this.processWithAIHub(context, appId, userMessage, user);
    } catch (error) {
      console.error('Error handling Teams message:', error);
      await context.sendActivity(
        MessageFactory.text(
          'Sorry, I encountered an error processing your request. Please try again.'
        )
      );
    }
  }

  /**
   * Map user message to appropriate AI Hub app using simple intent detection
   */
  async mapUserIntentToApp(message) {
    const apps = await loadAppConfigurations();
    const lowerMessage = message.toLowerCase();

    // Intent mapping based on keywords
    const intentMap = {
      // Translation
      translate: ['translator', 'translation-assistant'],
      übersetze: ['translator', 'translation-assistant'],
      traduce: ['translator', 'translation-assistant'],

      // Summarization
      summary: ['summarizer', 'document-summarizer'],
      summarize: ['summarizer', 'document-summarizer'],
      zusammenfassung: ['summarizer', 'document-summarizer'],

      // Code assistance
      code: ['code-assistant', 'code-reviewer', 'code-generator'],
      programming: ['code-assistant', 'code-generator'],
      debug: ['code-reviewer', 'code-assistant'],

      // Writing assistance
      write: ['writing-assistant', 'content-creator'],
      email: ['email-assistant', 'writing-assistant'],
      letter: ['writing-assistant', 'formal-writer'],

      // Analysis
      analyze: ['data-analyst', 'text-analyzer'],
      analysis: ['data-analyst', 'text-analyzer'],

      // FAQ/Help
      help: ['faq-bot', 'help-assistant'],
      question: ['faq-bot', 'help-assistant'],
      support: ['help-assistant', 'faq-bot']
    };

    // Find best matching app
    for (const [keyword, appIds] of Object.entries(intentMap)) {
      if (lowerMessage.includes(keyword)) {
        // Find first available app from the list
        for (const appId of appIds) {
          if (apps[appId]) {
            return appId;
          }
        }
      }
    }

    // Default fallback - use first available general assistant app
    const fallbackApps = ['assistant', 'general-assistant', 'help-assistant', 'faq-bot'];
    for (const appId of fallbackApps) {
      if (apps[appId]) {
        return appId;
      }
    }

    // If no fallback found, use first available app
    const availableApps = Object.keys(apps).filter(id => apps[id].enabled !== false);
    return availableApps[0] || null;
  }

  /**
   * Extract user information from Teams context
   */
  extractUserFromContext(context) {
    const activity = context.activity;

    return {
      id: activity.from?.id,
      name: activity.from?.name,
      email: activity.from?.email,
      teamsUserId: activity.from?.aadObjectId,
      channelId: activity.channelId,
      tenantId: activity.conversation?.tenantId,
      groups: ['authenticated', 'microsoft-users'] // Default groups for Teams users
    };
  }

  /**
   * Process message with AI Hub chat service and stream response back to Teams
   */
  async processWithAIHub(context, appId, message, user) {
    try {
      const apps = await loadAppConfigurations();
      const app = apps[appId];

      if (!app) {
        await context.sendActivity(MessageFactory.text(`App "${appId}" not found.`));
        return;
      }

      // Prepare chat request
      const chatRequest = {
        message: message,
        variables: {},
        sessionId: `teams-${context.activity.conversation.id}-${Date.now()}`,
        user: user
      };

      // Send initial response indicating processing
      const processingMessage = await context.sendActivity(
        MessageFactory.text(`🤖 Processing with ${app.name?.en || appId}...`)
      );

      // Create response collector
      let responseText = '';

      // Process with chat service (simplified non-streaming version for Teams)
      const response = await this.chatService.processNonStreaming(appId, chatRequest);

      if (response && response.content) {
        responseText = response.content;
      }

      // Update the processing message with the final response
      if (responseText) {
        const responseMessage = MessageFactory.text(responseText);
        responseMessage.id = processingMessage.id; // Update the same message
        await context.sendActivity(responseMessage);
      } else {
        await context.sendActivity(MessageFactory.text("Sorry, I couldn't generate a response."));
      }
    } catch (error) {
      console.error('Error processing with AI Hub:', error);
      await context.sendActivity(
        MessageFactory.text(
          'Sorry, there was an error processing your request with the AI service.'
        )
      );
    }
  }

  /**
   * Create welcome card with available apps
   */
  createWelcomeCard() {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.2',
      body: [
        {
          type: 'TextBlock',
          size: 'Medium',
          weight: 'Bolder',
          text: '🤖 AI Hub Apps Bot',
          color: 'Accent'
        },
        {
          type: 'TextBlock',
          text: 'Welcome! I can help you with various AI-powered tasks:',
          wrap: true
        },
        {
          type: 'TextBlock',
          text: '• **Translation** - "Translate this to German"\n• **Summarization** - "Summarize this document"\n• **Code Help** - "Help me write a Python function"\n• **Writing** - "Write a professional email"\n• **Analysis** - "Analyze this data"',
          wrap: true
        },
        {
          type: 'TextBlock',
          text: "Just describe what you need and I'll use the right AI app to help you!",
          wrap: true,
          weight: 'Lighter'
        }
      ]
    };

    return CardFactory.adaptiveCard(card);
  }
}

/**
 * Create and configure Bot Framework Adapter
 */
function createTeamsAdapter() {
  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;

  if (!appId || !appPassword) {
    console.warn('Teams integration disabled: TEAMS_APP_ID or TEAMS_APP_PASSWORD not configured');
    return null;
  }

  const adapter = new BotFrameworkAdapter({
    appId: appId,
    appPassword: appPassword
  });

  // Error handler
  adapter.onTurnError = async (context, error) => {
    console.error('Teams bot error:', error);
    await context.sendActivity(
      MessageFactory.text('Sorry, something went wrong. Please try again.')
    );
  };

  return adapter;
}

export { TeamsBot, createTeamsAdapter };
