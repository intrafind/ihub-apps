import { ValidationError } from '../utils/ErrorHandler.js';

/**
 * Content part types for multimodal messages
 */
export class ContentPart {
  constructor(type, data) {
    this.type = type;
    this.data = data;
  }

  static text(text) {
    return new ContentPart('text', { text });
  }

  static image(imageData) {
    if (typeof imageData === 'string') {
      // URL
      return new ContentPart('image', { url: imageData });
    } else if (imageData.base64) {
      // Base64 data
      return new ContentPart('image', { 
        base64: imageData.base64, 
        mimeType: imageData.mimeType || 'image/jpeg'
      });
    } else if (imageData.url) {
      // URL object
      return new ContentPart('image', { url: imageData.url });
    }
    throw new ValidationError('Invalid image data format', 'imageData', imageData);
  }

  static toolCall(toolCall) {
    return new ContentPart('tool_call', { toolCall });
  }

  static toolResult(toolCallId, result) {
    return new ContentPart('tool_result', { toolCallId, result });
  }

  toJSON() {
    return {
      type: this.type,
      ...this.data
    };
  }
}

/**
 * Tool call representation
 */
export class ToolCall {
  constructor(id, name, args) {
    this.id = id;
    this.name = name;
    this.arguments = args;
  }

  static fromJSON(data) {
    return new ToolCall(data.id, data.name, data.arguments);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      arguments: this.arguments
    };
  }
}

/**
 * Message class for chat messages with multimodal support
 */
export class Message {
  constructor(role, content, options = {}) {
    this.role = role;
    this.content = content;
    this.name = options.name;
    this.toolCallId = options.toolCallId;
    this.toolCalls = options.toolCalls?.map(tc => 
      tc instanceof ToolCall ? tc : ToolCall.fromJSON(tc)
    );
    this.timestamp = options.timestamp || new Date().toISOString();
    this.id = options.id || this.generateId();
  }

  /**
   * Generate unique message ID
   * @returns {string} Unique identifier
   */
  generateId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create system message
   * @param {string} content - System message content
   * @param {Object} options - Additional options
   * @returns {Message} System message
   */
  static system(content, options = {}) {
    return new Message('system', content, options);
  }

  /**
   * Create user message
   * @param {string|Array<ContentPart>} content - Message content
   * @param {Object} options - Additional options
   * @returns {Message} User message
   */
  static user(content, options = {}) {
    return new Message('user', content, options);
  }

  /**
   * Create user message with image
   * @param {string} text - Text content
   * @param {string|Object} imageData - Image URL or base64 data
   * @param {Object} options - Additional options
   * @returns {Message} User message with image
   */
  static userWithImage(text, imageData, options = {}) {
    const content = [
      ContentPart.text(text),
      ContentPart.image(imageData)
    ];
    return new Message('user', content, options);
  }

  /**
   * Create assistant message
   * @param {string} content - Assistant response content
   * @param {Object} options - Additional options
   * @returns {Message} Assistant message
   */
  static assistant(content, options = {}) {
    return new Message('assistant', content, options);
  }

  /**
   * Create assistant message with tool calls
   * @param {string} content - Response content (can be empty)
   * @param {Array<ToolCall>} toolCalls - Tool calls made by assistant
   * @param {Object} options - Additional options
   * @returns {Message} Assistant message with tool calls
   */
  static assistantWithToolCalls(content, toolCalls, options = {}) {
    return new Message('assistant', content, { ...options, toolCalls });
  }

  /**
   * Create tool response message
   * @param {string} toolCallId - ID of the tool call being responded to
   * @param {*} result - Tool execution result
   * @param {string} toolName - Name of the tool
   * @param {Object} options - Additional options
   * @returns {Message} Tool response message
   */
  static toolResponse(toolCallId, result, toolName, options = {}) {
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    return new Message('tool', content, { 
      ...options, 
      toolCallId, 
      name: toolName 
    });
  }

  /**
   * Check if message has image content
   * @returns {boolean} Whether message contains images
   */
  hasImages() {
    if (typeof this.content === 'string') {
      return false;
    }
    if (Array.isArray(this.content)) {
      return this.content.some(part => part.type === 'image');
    }
    return false;
  }

  /**
   * Check if message has tool calls
   * @returns {boolean} Whether message contains tool calls
   */
  hasToolCalls() {
    return !!(this.toolCalls && this.toolCalls.length > 0);
  }

  /**
   * Get text content from message
   * @returns {string} Text content
   */
  getTextContent() {
    if (typeof this.content === 'string') {
      return this.content;
    }
    if (Array.isArray(this.content)) {
      const textParts = this.content
        .filter(part => part.type === 'text')
        .map(part => part.data.text);
      return textParts.join(' ');
    }
    return '';
  }

  /**
   * Get image content from message
   * @returns {Array<Object>} Image content parts
   */
  getImageContent() {
    if (typeof this.content === 'string') {
      return [];
    }
    if (Array.isArray(this.content)) {
      return this.content
        .filter(part => part.type === 'image')
        .map(part => part.data);
    }
    return [];
  }

  /**
   * Clone message with modifications
   * @param {Object} changes - Changes to apply
   * @returns {Message} Cloned message
   */
  clone(changes = {}) {
    return new Message(
      changes.role || this.role,
      changes.content || this.content,
      {
        name: changes.name || this.name,
        toolCallId: changes.toolCallId || this.toolCallId,
        toolCalls: changes.toolCalls || this.toolCalls,
        timestamp: changes.timestamp || this.timestamp,
        id: changes.id || this.id
      }
    );
  }

  /**
   * Convert message to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    const json = {
      id: this.id,
      role: this.role,
      content: Array.isArray(this.content) ? 
        this.content.map(part => part.toJSON()) : 
        this.content,
      timestamp: this.timestamp
    };

    if (this.name) json.name = this.name;
    if (this.toolCallId) json.toolCallId = this.toolCallId;
    if (this.toolCalls) json.toolCalls = this.toolCalls.map(tc => tc.toJSON());

    return json;
  }

  /**
   * Create message from JSON
   * @param {Object} data - JSON data
   * @returns {Message} Message instance
   */
  static fromJSON(data) {
    let content = data.content;
    
    // Convert content parts if it's an array
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (part.type === 'text') {
          return ContentPart.text(part.text);
        } else if (part.type === 'image') {
          return ContentPart.image(part);
        } else if (part.type === 'tool_call') {
          return ContentPart.toolCall(part.toolCall);
        } else if (part.type === 'tool_result') {
          return ContentPart.toolResult(part.toolCallId, part.result);
        }
        return part;
      });
    }

    return new Message(data.role, content, {
      name: data.name,
      toolCallId: data.toolCallId,
      toolCalls: data.toolCalls?.map(tc => ToolCall.fromJSON(tc)),
      timestamp: data.timestamp,
      id: data.id
    });
  }

  /**
   * Validate message structure
   * @throws {ValidationError} If message is invalid
   */
  validate() {
    // Role validation
    const validRoles = ['system', 'user', 'assistant', 'tool'];
    if (!validRoles.includes(this.role)) {
      throw new ValidationError(
        `Invalid message role: ${this.role}`,
        'role',
        this.role
      );
    }

    // Content validation
    if (this.content === null || this.content === undefined) {
      throw new ValidationError('Message content cannot be null or undefined', 'content');
    }

    // Tool message validation
    if (this.role === 'tool') {
      if (!this.toolCallId) {
        throw new ValidationError(
          'Tool messages must have toolCallId',
          'toolCallId',
          this.toolCallId
        );
      }
      if (!this.name) {
        throw new ValidationError('Tool messages must have name', 'name', this.name);
      }
    }

    // Assistant tool calls validation
    if (this.role === 'assistant' && this.toolCalls) {
      this.toolCalls.forEach((toolCall, index) => {
        if (!toolCall.id || !toolCall.name) {
          throw new ValidationError(
            `Tool call at index ${index} missing required fields`,
            `toolCalls[${index}]`,
            toolCall
          );
        }
      });
    }
  }
}

/**
 * Utility function to create a conversation from message array
 * @param {Array<Object>} messages - Array of message data
 * @returns {Array<Message>} Array of Message instances
 */
export function createConversation(messages) {
  return messages.map(msg => 
    msg instanceof Message ? msg : Message.fromJSON(msg)
  );
}

/**
 * Utility function to count tokens in messages (rough estimate)
 * @param {Array<Message>} messages - Messages to count
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(messages) {
  let totalTokens = 0;
  
  for (const message of messages) {
    const content = message.getTextContent();
    // Rough token estimation: ~4 characters per token
    totalTokens += Math.ceil(content.length / 4);
    
    // Add tokens for role and formatting
    totalTokens += 4;
    
    // Add tokens for tool calls
    if (message.hasToolCalls()) {
      totalTokens += message.toolCalls.length * 10;
    }
    
    // Add tokens for images (rough estimate)
    if (message.hasImages()) {
      totalTokens += message.getImageContent().length * 85; // ~85 tokens per image
    }
  }
  
  return totalTokens;
}