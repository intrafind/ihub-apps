// Microsoft Teams Message Extension Handler for AI Hub Apps
// Handles context menu actions and message extension requests

import { loadAppConfigurations } from './configCache.js';
import { ChatService } from './services/chat/ChatService.js';

/**
 * Teams Message Extension Handler
 * Processes action-based message extensions (context menu items)
 */
class TeamsMessageExtension {
  constructor() {
    this.chatService = new ChatService();
  }

  /**
   * Handle message extension action requests
   */
  async handleMessageExtensionAction(context) {
    try {
      const action = context.activity.value;
      const commandId = action.commandId;

      // Extract content from the selected message or attachment
      const content = this.extractContentFromAction(action);

      if (!content) {
        return this.createErrorResponse('No content found to process.');
      }

      // Map command to AI Hub app
      const appId = this.mapCommandToApp(commandId);

      if (!appId) {
        return this.createErrorResponse(`Unknown command: ${commandId}`);
      }

      // Get user information
      const user = this.extractUserFromContext(context);

      // Process with AI Hub
      const result = await this.processWithAIHub(appId, content, user);

      return this.createSuccessResponse(result, appId);
    } catch (error) {
      console.error('Error handling message extension action:', error);
      return this.createErrorResponse('An error occurred processing your request.');
    }
  }

  /**
   * Extract content from message extension action
   */
  extractContentFromAction(action) {
    // Check for selected text
    if (action.messagePayload?.body?.content) {
      return action.messagePayload.body.content;
    }

    // Check for message text
    if (action.messagePayload?.body?.value) {
      return action.messagePayload.body.value;
    }

    // Check for attachment content
    if (action.messagePayload?.attachments && action.messagePayload.attachments.length > 0) {
      const attachment = action.messagePayload.attachments[0];

      // Handle different attachment types
      if (attachment.contentType === 'text/plain' || attachment.contentType === 'text/html') {
        return attachment.content || attachment.contentUrl;
      }

      // For other file types, return file info
      return `File: ${attachment.name} (${attachment.contentType})\\nURL: ${attachment.contentUrl}`;
    }

    // Fallback to any available text
    return action.messagePayload?.from?.user?.displayName
      ? `Message from ${action.messagePayload.from.user.displayName}`
      : null;
  }

  /**
   * Map message extension command to AI Hub app
   */
  mapCommandToApp(commandId) {
    const commandMap = {
      summarize: 'summarizer',
      translate: 'translator',
      analyze: 'data-analyst',
      'improve-writing': 'writing-assistant',
      'extract-key-points': 'text-analyzer',
      'generate-response': 'response-generator',
      'fact-check': 'fact-checker',
      'sentiment-analysis': 'sentiment-analyzer'
    };

    return commandMap[commandId] || null;
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
      groups: ['authenticated', 'microsoft-users']
    };
  }

  /**
   * Process content with AI Hub chat service
   */
  async processWithAIHub(appId, content, user) {
    try {
      const apps = await loadAppConfigurations();
      const app = apps[appId];

      if (!app) {
        throw new Error(`App "${appId}" not found`);
      }

      // Prepare chat request
      const chatRequest = {
        message: content,
        variables: {},
        sessionId: `teams-extension-${user.id}-${Date.now()}`,
        user: user
      };

      // Process with chat service
      const response = await this.chatService.processNonStreaming(appId, chatRequest);

      if (response && response.content) {
        return response.content;
      }

      throw new Error('No response generated');
    } catch (error) {
      console.error('Error processing with AI Hub:', error);
      throw error;
    }
  }

  /**
   * Create success response for message extension
   */
  createSuccessResponse(result, appId) {
    return {
      composeExtension: {
        type: 'result',
        attachmentLayout: 'list',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.2',
              body: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: `AI Hub: ${this.getAppDisplayName(appId)}`,
                  color: 'Accent'
                },
                {
                  type: 'TextBlock',
                  text: result,
                  wrap: true
                }
              ],
              actions: [
                {
                  type: 'Action.Submit',
                  title: 'Send to Chat',
                  data: {
                    action: 'send',
                    result: result
                  }
                }
              ]
            }
          }
        ]
      }
    };
  }

  /**
   * Create error response for message extension
   */
  createErrorResponse(errorMessage) {
    return {
      composeExtension: {
        type: 'result',
        attachmentLayout: 'list',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.2',
              body: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: '❌ Error',
                  color: 'Attention'
                },
                {
                  type: 'TextBlock',
                  text: errorMessage,
                  wrap: true
                }
              ]
            }
          }
        ]
      }
    };
  }

  /**
   * Get display name for app
   */
  getAppDisplayName(appId) {
    const displayNames = {
      summarizer: '📄 Summarizer',
      translator: '🌐 Translator',
      'data-analyst': '📊 Data Analyst',
      'writing-assistant': '✍️ Writing Assistant',
      'text-analyzer': '🔍 Text Analyzer',
      'response-generator': '💬 Response Generator',
      'fact-checker': '✅ Fact Checker',
      'sentiment-analyzer': '😊 Sentiment Analyzer'
    };

    return displayNames[appId] || appId;
  }

  /**
   * Handle compose extension query (for search-based extensions)
   */
  async handleComposeExtensionQuery(context) {
    try {
      const query = context.activity.value.parameters[0];
      const searchQuery = query.value;

      // Simple app search functionality
      const apps = await loadAppConfigurations();
      const results = [];

      for (const [appId, app] of Object.entries(apps)) {
        if (
          app.enabled !== false &&
          (app.name?.en?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            app.description?.en?.toLowerCase().includes(searchQuery.toLowerCase()))
        ) {
          results.push({
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.2',
              body: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: app.name?.en || appId
                },
                {
                  type: 'TextBlock',
                  text: app.description?.en || 'AI-powered assistant',
                  wrap: true,
                  isSubtle: true
                }
              ],
              actions: [
                {
                  type: 'Action.Submit',
                  title: 'Use This App',
                  data: {
                    action: 'selectApp',
                    appId: appId
                  }
                }
              ]
            }
          });
        }

        // Limit results
        if (results.length >= 5) break;
      }

      return {
        composeExtension: {
          type: 'result',
          attachmentLayout: 'list',
          attachments: results
        }
      };
    } catch (error) {
      console.error('Error handling compose extension query:', error);
      return this.createErrorResponse('Error searching apps');
    }
  }
}

export { TeamsMessageExtension };
