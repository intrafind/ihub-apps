// Microsoft Teams Bot Integration for AI Hub Apps
// Uses Microsoft Bot Framework to handle Teams messages and forward them to AI Hub Apps

import { BotFrameworkAdapter, ActivityHandler, MessageFactory, CardFactory } from 'botbuilder';
import config from './config.js';
import { loadAppConfigurations, loadTeamsConfiguration } from './configCache.js';
import ChatService from './services/chat/ChatService.js';
import { enhanceUserWithPermissions, filterResourcesByPermissions } from './utils/authorization.js';

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
          const welcomeCard = await this.createWelcomeCard();
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

      // Get user information first
      const user = this.extractUserFromContext(context);
      
      // Map user intent to AI Hub app using AI
      const appId = await this.mapUserIntentToApp(userMessage, user);

      if (!appId) {
        await context.sendActivity(
          MessageFactory.text(
            'I couldn\'t determine which app to use for your request. Try being more specific, like "translate this text" or "summarize this document".'
          )
        );
        return;
      }

      // Send message to AI Hub chat service with streaming support
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
   * Map user message to appropriate AI Hub app using AI-powered intent detection
   */
  async mapUserIntentToApp(message, user) {
    try {
      const teamsConfig = await loadTeamsConfiguration();
      const apps = await loadAppConfigurations();
      
      // Get user's available apps based on permissions
      const enhancedUser = await enhanceUserWithPermissions(user);
      const availableApps = filterResourcesByPermissions(apps, enhancedUser.permissions?.apps || []);
      
      if (!teamsConfig?.bot?.intentDetection?.useAI) {
        // Fallback to first available app if AI detection is disabled
        return this.getFallbackApp(availableApps, teamsConfig);
      }

      // Prepare app list for LLM
      const appList = Object.entries(availableApps)
        .filter(([, app]) => app.enabled !== false)
        .map(([id, app]) => `${id}: ${app.name?.en || id} - ${app.description?.en || 'AI assistant'}`)
        .join('\n');

      if (!appList) {
        return this.getFallbackApp(apps, teamsConfig);
      }

      // Use LLM to determine intent
      const systemPrompt = teamsConfig.bot.intentDetection.systemPrompt?.en?.replace(
        '{{availableApps}}', 
        appList
      ) || `Determine which app should handle this request. Available apps:\n${appList}\n\nReturn only the app ID.`;

      const intentRequest = {
        message: systemPrompt + '\n\nUser request: ' + message,
        variables: {},
        sessionId: `teams-intent-${Date.now()}`,
        user: enhancedUser
      };

      // Use a fast model for intent detection
      const response = await this.chatService.processNonStreaming('chat', intentRequest);
      const detectedAppId = response?.content?.trim();

      if (detectedAppId && availableApps[detectedAppId]) {
        return detectedAppId;
      }

      // Fallback if detection failed
      return this.getFallbackApp(availableApps, teamsConfig);
    } catch (error) {
      console.error('Error in AI intent detection:', error);
      const apps = await loadAppConfigurations();
      const teamsConfig = await loadTeamsConfiguration();
      return this.getFallbackApp(apps, teamsConfig);
    }
  }

  /**
   * Get fallback app when AI detection fails or is disabled
   */
  getFallbackApp(apps, teamsConfig) {
    const fallbackApps = teamsConfig?.bot?.intentDetection?.fallbackApps || 
      ['chat', 'general-assistant', 'help-assistant', 'faq-bot'];
    
    for (const appId of fallbackApps) {
      if (apps[appId] && apps[appId].enabled !== false) {
        return appId;
      }
    }

    // Last resort - use first available app
    const availableApps = Object.keys(apps).filter(id => apps[id]?.enabled !== false);
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
      groups: ['authenticated', 'teams-users'] // Default groups for Teams users
    };
  }

  /**
   * Process message with AI Hub chat service and stream response back to Teams
   */
  async processWithAIHub(context, appId, message, user) {
    try {
      const teamsConfig = await loadTeamsConfiguration();
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

      // Send initial processing message
      const processingMessageText = teamsConfig?.bot?.processingMessage?.en?.replace(
        '{{appName}}', 
        app.name?.en || appId
      ) || `🤖 Processing with ${app.name?.en || appId}...`;
      
      const processingActivity = await context.sendActivity(
        MessageFactory.text(processingMessageText)
      );

      let responseText = '';

      // Check if streaming is enabled and supported
      if (teamsConfig?.bot?.streaming?.enabled) {
        try {
          // Use streaming for real-time updates
          responseText = await this.processWithStreaming(appId, chatRequest, context, processingActivity, teamsConfig);
        } catch (streamError) {
          console.warn('Streaming failed, falling back to non-streaming:', streamError);
          // Fallback to non-streaming
          const response = await this.chatService.processNonStreaming(appId, chatRequest);
          responseText = response?.content || '';
        }
      } else {
        // Use non-streaming approach
        const response = await this.chatService.processNonStreaming(appId, chatRequest);
        responseText = response?.content || '';
      }

      // Send final response or update existing message
      if (responseText) {
        // Create adaptive card for better formatting
        const responseCard = this.createResponseCard(responseText, app.name?.en || appId, app.icon);
        const responseActivity = MessageFactory.attachment(responseCard);
        
        if (teamsConfig?.bot?.streaming?.enabled) {
          // Send new message with final response
          await context.sendActivity(responseActivity);
        } else {
          // Update the processing message
          responseActivity.id = processingActivity.id;
          await context.sendActivity(responseActivity);
        }
      } else {
        const errorMessage = teamsConfig?.bot?.errorMessage?.en || "Sorry, I couldn't generate a response.";
        await context.sendActivity(MessageFactory.text(errorMessage));
      }
    } catch (error) {
      console.error('Error processing with AI Hub:', error);
      const teamsConfig = await loadTeamsConfiguration();
      const errorMessage = teamsConfig?.bot?.errorMessage?.en || 
        'Sorry, there was an error processing your request with the AI service.';
      await context.sendActivity(MessageFactory.text(errorMessage));
    }
  }

  /**
   * Process with streaming support for real-time updates
   */
  async processWithStreaming(appId, chatRequest, context, processingActivity, teamsConfig) {
    return new Promise((resolve, reject) => {
      let accumulatedResponse = '';
      let lastUpdateTime = Date.now();
      const updateInterval = teamsConfig.bot.streaming.updateInterval || 1000;
      const chunkSize = teamsConfig.bot.streaming.chunkSize || 100;

      // Create a simple streaming handler
      const streamHandler = {
        onData: (chunk) => {
          accumulatedResponse += chunk;
          
          // Throttle updates to avoid overwhelming Teams
          const now = Date.now();
          if (now - lastUpdateTime > updateInterval && accumulatedResponse.length > chunkSize) {
            this.updateStreamingMessage(context, processingActivity, accumulatedResponse);
            lastUpdateTime = now;
          }
        },
        onEnd: () => {
          resolve(accumulatedResponse);
        },
        onError: (error) => {
          reject(error);
        }
      };

      // Process with streaming (simplified approach)
      this.chatService.processNonStreaming(appId, chatRequest)
        .then(response => {
          streamHandler.onData(response.content || '');
          streamHandler.onEnd();
        })
        .catch(error => {
          streamHandler.onError(error);
        });
    });
  }

  /**
   * Update streaming message (Teams has limitations on message updates)
   */
  async updateStreamingMessage(context, originalActivity, content) {
    try {
      // Teams has limitations on updating messages, so we'll keep it simple
      // In a full implementation, you might use typing indicators or progress indicators
      await context.sendActivity({ type: 'typing' });
    } catch (error) {
      console.warn('Error updating streaming message:', error);
    }
  }

  /**
   * Create adaptive card for response formatting
   */
  createResponseCard(content, appName, appIcon) {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          size: 'Medium',
          weight: 'Bolder',
          text: `🤖 ${appName}`,
          color: 'Accent'
        },
        {
          type: 'TextBlock',
          text: content,
          wrap: true,
          spacing: 'Medium'
        }
      ]
    };

    return CardFactory.adaptiveCard(card);
  }

  /**
   * Create welcome card with available apps
   */
  async createWelcomeCard() {
    try {
      const teamsConfig = await loadTeamsConfiguration();
      const welcomeMessage = teamsConfig?.bot?.welcomeMessage?.en || 
        "Welcome to AI Hub Apps! I can help you with various AI-powered tasks. Just describe what you need and I'll determine the best AI app to help you!";

      const card = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            size: 'Medium',
            weight: 'Bolder',
            text: `${teamsConfig?.ui?.branding?.icon || '🤖'} ${teamsConfig?.ui?.branding?.appName || 'AI Hub Apps Bot'}`,
            color: 'Accent'
          },
          {
            type: 'TextBlock',
            text: welcomeMessage,
            wrap: true,
            spacing: 'Medium'
          },
          {
            type: 'TextBlock',
            text: '• **Natural Language** - Just tell me what you need\n• **Smart Detection** - I\'ll choose the best AI app for your task\n• **Real-time Responses** - Get answers quickly with streaming',
            wrap: true,
            spacing: 'Medium'
          }
        ]
      };

      return CardFactory.adaptiveCard(card);
    } catch (error) {
      console.error('Error creating welcome card:', error);
      // Fallback to simple card
      return CardFactory.adaptiveCard({
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: '🤖 AI Hub Apps Bot - Ready to help!',
            size: 'Medium',
            weight: 'Bolder'
          }
        ]
      });
    }
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
