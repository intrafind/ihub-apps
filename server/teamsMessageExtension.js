// Microsoft Teams Message Extension Handler for AI Hub Apps
// Handles context menu actions and message extension requests

import { loadAppConfigurations, loadTeamsConfiguration } from './configCache.js';
import ChatService from './services/chat/ChatService.js';
import { enhanceUserWithPermissions, filterResourcesByPermissions } from './utils/authorization.js';

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

      // Extract content from the selected message or attachment with enhanced handling
      const extractedContent = await this.extractContentFromAction(action);

      if (!extractedContent) {
        return this.createErrorResponse('No content found to process.');
      }

      // Map command to AI Hub app using configuration
      const appId = await this.mapCommandToApp(commandId);

      if (!appId) {
        return this.createErrorResponse(`Unknown command: ${commandId}`);
      }

      // Get user information and enhance with permissions
      const user = this.extractUserFromContext(context);
      const enhancedUser = await enhanceUserWithPermissions(user);

      // Check if user has permission to use this app
      const apps = await loadAppConfigurations();
      const filteredApps = filterResourcesByPermissions(apps, enhancedUser.permissions?.apps || []);
      
      if (!filteredApps[appId]) {
        return this.createErrorResponse(`You don't have permission to use the ${appId} app.`);
      }

      // Process with AI Hub using the right app for content type
      const result = await this.processWithAIHub(appId, extractedContent, enhancedUser);

      return await this.createSuccessResponse(result, appId, commandId);
    } catch (error) {
      console.error('Error handling message extension action:', error);
      return this.createErrorResponse(error.message || 'An error occurred processing your request.');
    }
  }

  /**
   * Extract content from message extension action with improved image and file handling
   */
  async extractContentFromAction(action) {
    const teamsConfig = await loadTeamsConfiguration();
    
    // Check for selected text
    if (action.messagePayload?.body?.content) {
      return {
        type: 'text',
        content: action.messagePayload.body.content,
        metadata: {}
      };
    }

    // Check for message text
    if (action.messagePayload?.body?.value) {
      return {
        type: 'text',
        content: action.messagePayload.body.value,
        metadata: {}
      };
    }

    // Check for attachment content with enhanced handling
    if (action.messagePayload?.attachments && action.messagePayload.attachments.length > 0) {
      const attachment = action.messagePayload.attachments[0];
      
      // Handle images with AI Hub integration
      if (this.isImageType(attachment.contentType) && teamsConfig?.messageExtensions?.imageSupport?.enabled) {
        const maxSize = teamsConfig.messageExtensions.imageSupport.maxSize || 10485760; // 10MB default
        
        if (attachment.size && attachment.size > maxSize) {
          throw new Error(`Image size (${Math.round(attachment.size / 1024 / 1024)}MB) exceeds maximum allowed size (${Math.round(maxSize / 1024 / 1024)}MB)`);
        }
        
        return {
          type: 'image',
          content: attachment.contentUrl,
          metadata: {
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size
          }
        };
      }
      
      // Handle files with AI Hub integration
      if (this.isFileType(attachment.contentType) && teamsConfig?.messageExtensions?.fileSupport?.enabled) {
        const maxSize = teamsConfig.messageExtensions.fileSupport.maxSize || 52428800; // 50MB default
        
        if (attachment.size && attachment.size > maxSize) {
          throw new Error(`File size (${Math.round(attachment.size / 1024 / 1024)}MB) exceeds maximum allowed size (${Math.round(maxSize / 1024 / 1024)}MB)`);
        }
        
        return {
          type: 'file',
          content: attachment.contentUrl,
          metadata: {
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size
          }
        };
      }
      
      // Handle text attachments
      if (attachment.contentType === 'text/plain' || attachment.contentType === 'text/html') {
        return {
          type: 'text',
          content: attachment.content || attachment.contentUrl,
          metadata: {
            name: attachment.name,
            contentType: attachment.contentType
          }
        };
      }
      
      // For unsupported file types, provide file info
      return {
        type: 'text',
        content: `File: ${attachment.name} (${attachment.contentType})\nURL: ${attachment.contentUrl}`,
        metadata: {
          name: attachment.name,
          contentType: attachment.contentType,
          unsupported: true
        }
      };
    }

    // Fallback to any available text
    const fallbackText = action.messagePayload?.from?.user?.displayName
      ? `Message from ${action.messagePayload.from.user.displayName}`
      : null;
    
    return fallbackText ? {
      type: 'text',
      content: fallbackText,
      metadata: {}
    } : null;
  }
  
  /**
   * Check if content type is an image
   */
  isImageType(contentType) {
    const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];
    return imageTypes.includes(contentType?.toLowerCase());
  }
  
  /**
   * Check if content type is a supported file
   */
  isFileType(contentType) {
    const fileTypes = [
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    return fileTypes.includes(contentType?.toLowerCase());
  }

  /**
   * Map message extension command to AI Hub app using configuration
   */
  async mapCommandToApp(commandId) {
    try {
      const teamsConfig = await loadTeamsConfiguration();
      const commands = teamsConfig?.messageExtensions?.commands || [];
      
      const command = commands.find(cmd => cmd.id === commandId);
      return command?.appId || null;
    } catch (error) {
      console.error('Error mapping command to app:', error);
      // Fallback to hardcoded mapping
      const fallbackMap = {
        summarize: 'summarizer',
        translate: 'translator',
        analyze: 'chat',
        'improve-writing': 'email-composer',
        'extract-key-points': 'summarizer'
      };
      
      return fallbackMap[commandId] || null;
    }
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
      groups: ['authenticated', 'teams-users']
    };
  }

  /**
   * Process content with AI Hub chat service with enhanced content handling
   */
  async processWithAIHub(appId, extractedContent, user) {
    try {
      const apps = await loadAppConfigurations();
      const app = apps[appId];
      const teamsConfig = await loadTeamsConfiguration();

      if (!app) {
        throw new Error(`App "${appId}" not found`);
      }

      // Determine the appropriate app for content type
      const finalAppId = this.selectAppForContentType(appId, extractedContent, teamsConfig);
      const finalApp = apps[finalAppId] || app;

      // Prepare variables based on command configuration
      const variables = await this.prepareVariablesForCommand(extractedContent, teamsConfig);

      // Prepare chat request with enhanced content handling
      const chatRequest = {
        message: this.formatContentForAI(extractedContent),
        variables: variables,
        sessionId: `teams-extension-${user.id}-${Date.now()}`,
        user: user,
        files: extractedContent.type === 'image' || extractedContent.type === 'file' ? 
          [{
            name: extractedContent.metadata.name,
            type: extractedContent.metadata.contentType,
            url: extractedContent.content,
            size: extractedContent.metadata.size
          }] : undefined
      };

      // Process with chat service
      const response = await this.chatService.processNonStreaming(finalAppId, chatRequest);

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
   * Select appropriate app based on content type
   */
  selectAppForContentType(originalAppId, extractedContent, teamsConfig) {
    if (extractedContent.type === 'image' && teamsConfig?.messageExtensions?.imageSupport?.enabled) {
      return teamsConfig.messageExtensions.imageSupport.defaultApp || 'image-analysis';
    }
    
    if (extractedContent.type === 'file' && teamsConfig?.messageExtensions?.fileSupport?.enabled) {
      return teamsConfig.messageExtensions.fileSupport.defaultApp || 'file-analysis';
    }
    
    return originalAppId;
  }
  
  /**
   * Prepare variables for the command
   */
  async prepareVariablesForCommand(extractedContent, teamsConfig) {
    const variables = {};
    
    // Find the command configuration
    const commands = teamsConfig?.messageExtensions?.commands || [];
    const command = commands.find(cmd => cmd.appId);
    
    if (command?.variables) {
      Object.assign(variables, command.variables);
    }
    
    // Add content to variables if needed
    if (extractedContent.type === 'text') {
      variables.content = extractedContent.content;
    }
    
    return variables;
  }
  
  /**
   * Format content for AI processing
   */
  formatContentForAI(extractedContent) {
    switch (extractedContent.type) {
      case 'text':
        return extractedContent.content;
      case 'image':
        return `Analyze this image: ${extractedContent.metadata.name}`;
      case 'file':
        return `Process this file: ${extractedContent.metadata.name} (${extractedContent.metadata.contentType})`;
      default:
        return extractedContent.content;
    }
  }

  /**
   * Create success response for message extension
   */
  async createSuccessResponse(result, appId, commandId) {
    const displayName = await this.getAppDisplayName(appId, commandId);
    
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
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: `AI Hub: ${displayName}`,
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
   * Get display name for app using configuration
   */
  async getAppDisplayName(appId, commandId) {
    try {
      const [apps, teamsConfig] = await Promise.all([
        loadAppConfigurations(),
        loadTeamsConfiguration()
      ]);
      
      // First try to get name from Teams command configuration
      if (commandId && teamsConfig?.messageExtensions?.commands) {
        const command = teamsConfig.messageExtensions.commands.find(cmd => cmd.id === commandId);
        if (command?.title?.en) {
          return `${command.icon || '🤖'} ${command.title.en}`;
        }
      }
      
      // Then try to get name from app configuration
      const app = apps[appId];
      if (app?.name?.en) {
        return `🤖 ${app.name.en}`;
      }
      
      // Fallback to hardcoded display names
      const fallbackDisplayNames = {
        summarizer: '📄 Summarizer',
        translator: '🌐 Translator',
        'chat': '💬 Chat Assistant',
        'email-composer': '✍️ Writing Assistant',
        'image-analysis': '🖼️ Image Analysis',
        'file-analysis': '📎 File Analysis'
      };
      
      return fallbackDisplayNames[appId] || `🤖 ${appId}`;
    } catch (error) {
      console.error('Error getting app display name:', error);
      return `🤖 ${appId}`;
    }
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
