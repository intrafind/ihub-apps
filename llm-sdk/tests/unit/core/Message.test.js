import {
  Message,
  ContentPart,
  ToolCall,
  createConversation,
  estimateTokenCount
} from '../../../src/core/Message.js';

describe('ContentPart', () => {
  describe('text', () => {
    it('should create text content part', () => {
      const part = ContentPart.text('Hello world');
      expect(part.type).toBe('text');
      expect(part.data.text).toBe('Hello world');
    });
  });

  describe('image', () => {
    it('should create image content part from URL', () => {
      const part = ContentPart.image('https://example.com/image.jpg');
      expect(part.type).toBe('image');
      expect(part.data.url).toBe('https://example.com/image.jpg');
    });

    it('should create image content part from base64', () => {
      const imageData = {
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        mimeType: 'image/png'
      };
      const part = ContentPart.image(imageData);
      expect(part.type).toBe('image');
      expect(part.data.base64).toBe(imageData.base64);
      expect(part.data.mimeType).toBe('image/png');
    });

    it('should default mimeType to image/jpeg for base64', () => {
      const imageData = { base64: 'base64data' };
      const part = ContentPart.image(imageData);
      expect(part.data.mimeType).toBe('image/jpeg');
    });
  });

  describe('toolCall', () => {
    it('should create tool call content part', () => {
      const toolCall = { id: '1', name: 'test', arguments: {} };
      const part = ContentPart.toolCall(toolCall);
      expect(part.type).toBe('tool_call');
      expect(part.data.toolCall).toEqual(toolCall);
    });
  });

  describe('toolResult', () => {
    it('should create tool result content part', () => {
      const part = ContentPart.toolResult('call-1', { result: 'success' });
      expect(part.type).toBe('tool_result');
      expect(part.data.toolCallId).toBe('call-1');
      expect(part.data.result).toEqual({ result: 'success' });
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON correctly', () => {
      const part = ContentPart.text('Hello');
      const json = part.toJSON();
      expect(json).toEqual({
        type: 'text',
        text: 'Hello'
      });
    });
  });
});

describe('ToolCall', () => {
  describe('constructor', () => {
    it('should create tool call', () => {
      const toolCall = new ToolCall('1', 'test_tool', { param: 'value' });
      expect(toolCall.id).toBe('1');
      expect(toolCall.name).toBe('test_tool');
      expect(toolCall.arguments).toEqual({ param: 'value' });
    });
  });

  describe('fromJSON', () => {
    it('should create from JSON', () => {
      const data = { id: '1', name: 'test', arguments: { a: 1 } };
      const toolCall = ToolCall.fromJSON(data);
      expect(toolCall).toBeInstanceOf(ToolCall);
      expect(toolCall.id).toBe('1');
      expect(toolCall.name).toBe('test');
      expect(toolCall.arguments).toEqual({ a: 1 });
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON', () => {
      const toolCall = new ToolCall('1', 'test', { param: 'value' });
      const json = toolCall.toJSON();
      expect(json).toEqual({
        id: '1',
        name: 'test',
        arguments: { param: 'value' }
      });
    });
  });
});

describe('Message', () => {
  describe('constructor', () => {
    it('should create basic message', () => {
      const message = new Message('user', 'Hello');
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello');
      expect(message.id).toBeDefined();
      expect(message.timestamp).toBeDefined();
    });

    it('should create message with options', () => {
      const options = {
        name: 'test-user',
        toolCallId: 'call-1',
        id: 'msg-123'
      };
      const message = new Message('user', 'Hello', options);
      expect(message.name).toBe('test-user');
      expect(message.toolCallId).toBe('call-1');
      expect(message.id).toBe('msg-123');
    });

    it('should convert tool calls to ToolCall instances', () => {
      const toolCalls = [{ id: '1', name: 'test', arguments: {} }];
      const message = new Message('assistant', 'Hello', { toolCalls });
      expect(message.toolCalls[0]).toBeInstanceOf(ToolCall);
    });
  });

  describe('static factories', () => {
    describe('system', () => {
      it('should create system message', () => {
        const message = Message.system('You are a helpful assistant');
        expect(message.role).toBe('system');
        expect(message.content).toBe('You are a helpful assistant');
      });
    });

    describe('user', () => {
      it('should create user message', () => {
        const message = Message.user('Hello');
        expect(message.role).toBe('user');
        expect(message.content).toBe('Hello');
      });
    });

    describe('userWithImage', () => {
      it('should create user message with image', () => {
        const message = Message.userWithImage('Look at this', 'https://example.com/image.jpg');
        expect(message.role).toBe('user');
        expect(Array.isArray(message.content)).toBe(true);
        expect(message.content).toHaveLength(2);
        expect(message.content[0].type).toBe('text');
        expect(message.content[1].type).toBe('image');
      });
    });

    describe('assistant', () => {
      it('should create assistant message', () => {
        const message = Message.assistant('Hello there!');
        expect(message.role).toBe('assistant');
        expect(message.content).toBe('Hello there!');
      });
    });

    describe('assistantWithToolCalls', () => {
      it('should create assistant message with tool calls', () => {
        const toolCalls = [new ToolCall('1', 'test', {})];
        const message = Message.assistantWithToolCalls('I need to call a tool', toolCalls);
        expect(message.role).toBe('assistant');
        expect(message.toolCalls).toEqual(toolCalls);
      });
    });

    describe('toolResponse', () => {
      it('should create tool response message', () => {
        const message = Message.toolResponse('call-1', 'Success', 'test_tool');
        expect(message.role).toBe('tool');
        expect(message.content).toBe('Success');
        expect(message.toolCallId).toBe('call-1');
        expect(message.name).toBe('test_tool');
      });

      it('should stringify non-string results', () => {
        const result = { success: true, data: [1, 2, 3] };
        const message = Message.toolResponse('call-1', result, 'test_tool');
        expect(message.content).toBe(JSON.stringify(result));
      });
    });
  });

  describe('content inspection', () => {
    describe('hasImages', () => {
      it('should return false for string content', () => {
        const message = new Message('user', 'Hello');
        expect(message.hasImages()).toBe(false);
      });

      it('should return false for array content without images', () => {
        const content = [ContentPart.text('Hello')];
        const message = new Message('user', content);
        expect(message.hasImages()).toBe(false);
      });

      it('should return true for array content with images', () => {
        const content = [
          ContentPart.text('Hello'),
          ContentPart.image('https://example.com/image.jpg')
        ];
        const message = new Message('user', content);
        expect(message.hasImages()).toBe(true);
      });
    });

    describe('hasToolCalls', () => {
      it('should return false when no tool calls', () => {
        const message = new Message('assistant', 'Hello');
        expect(message.hasToolCalls()).toBe(false);
      });

      it('should return true when has tool calls', () => {
        const toolCalls = [new ToolCall('1', 'test', {})];
        const message = new Message('assistant', 'Hello', { toolCalls });
        expect(message.hasToolCalls()).toBe(true);
      });
    });

    describe('getTextContent', () => {
      it('should return string content directly', () => {
        const message = new Message('user', 'Hello world');
        expect(message.getTextContent()).toBe('Hello world');
      });

      it('should extract text from array content', () => {
        const content = [
          ContentPart.text('Hello'),
          ContentPart.text(' world'),
          ContentPart.image('https://example.com/image.jpg')
        ];
        const message = new Message('user', content);
        expect(message.getTextContent()).toBe('Hello  world');
      });
    });

    describe('getImageContent', () => {
      it('should return empty array for string content', () => {
        const message = new Message('user', 'Hello');
        expect(message.getImageContent()).toEqual([]);
      });

      it('should extract image data from array content', () => {
        const content = [
          ContentPart.text('Hello'),
          ContentPart.image('https://example.com/image.jpg')
        ];
        const message = new Message('user', content);
        const images = message.getImageContent();
        expect(images).toHaveLength(1);
        expect(images[0].url).toBe('https://example.com/image.jpg');
      });
    });
  });

  describe('validation', () => {
    describe('validate', () => {
      it('should pass validation for valid message', () => {
        const message = Message.user('Hello');
        expect(() => message.validate()).not.toThrow();
      });

      it('should throw for invalid role', () => {
        const message = new Message('invalid', 'Hello');
        expect(() => message.validate()).toThrow('Invalid message role');
      });

      it('should throw for tool message without toolCallId', () => {
        const message = new Message('tool', 'Result', { name: 'test' });
        expect(() => message.validate()).toThrow('Tool messages must have toolCallId');
      });

      it('should throw for tool message without name', () => {
        const message = new Message('tool', 'Result', { toolCallId: 'call-1' });
        expect(() => message.validate()).toThrow('Tool messages must have name');
      });

      it('should throw for null content', () => {
        const message = new Message('user', null);
        expect(() => message.validate()).toThrow('Message content cannot be null');
      });
    });
  });

  describe('serialization', () => {
    describe('toJSON', () => {
      it('should serialize basic message', () => {
        const message = Message.user('Hello');
        const json = message.toJSON();
        expect(json.role).toBe('user');
        expect(json.content).toBe('Hello');
        expect(json.id).toBeDefined();
        expect(json.timestamp).toBeDefined();
      });

      it('should serialize message with tool calls', () => {
        const toolCalls = [new ToolCall('1', 'test', { param: 'value' })];
        const message = new Message('assistant', 'Hello', { toolCalls });
        const json = message.toJSON();
        expect(json.toolCalls).toHaveLength(1);
        expect(json.toolCalls[0]).toEqual({
          id: '1',
          name: 'test',
          arguments: { param: 'value' }
        });
      });
    });

    describe('fromJSON', () => {
      it('should deserialize basic message', () => {
        const data = {
          role: 'user',
          content: 'Hello',
          id: 'msg-123',
          timestamp: '2023-01-01T00:00:00.000Z'
        };
        const message = Message.fromJSON(data);
        expect(message.role).toBe('user');
        expect(message.content).toBe('Hello');
        expect(message.id).toBe('msg-123');
      });

      it('should deserialize message with array content', () => {
        const data = {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image', url: 'https://example.com/image.jpg' }
          ]
        };
        const message = Message.fromJSON(data);
        expect(Array.isArray(message.content)).toBe(true);
        expect(message.content[0]).toBeInstanceOf(ContentPart);
        expect(message.content[1]).toBeInstanceOf(ContentPart);
      });
    });
  });

  describe('clone', () => {
    it('should clone message with no changes', () => {
      const original = Message.user('Hello');
      const cloned = original.clone();
      expect(cloned.id).toBe(original.id);
      expect(cloned.role).toBe(original.role);
      expect(cloned.content).toBe(original.content);
    });

    it('should clone message with changes', () => {
      const original = Message.user('Hello');
      const cloned = original.clone({ content: 'Goodbye' });
      expect(cloned.id).toBe(original.id);
      expect(cloned.role).toBe(original.role);
      expect(cloned.content).toBe('Goodbye');
    });
  });
});

describe('utility functions', () => {
  describe('createConversation', () => {
    it('should create conversation from message objects', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];
      const conversation = createConversation(messages);
      expect(conversation).toHaveLength(2);
      expect(conversation[0]).toBeInstanceOf(Message);
      expect(conversation[1]).toBeInstanceOf(Message);
    });

    it('should preserve existing Message instances', () => {
      const message1 = Message.user('Hello');
      const messages = [message1, { role: 'assistant', content: 'Hi!' }];
      const conversation = createConversation(messages);
      expect(conversation[0]).toBe(message1);
      expect(conversation[1]).toBeInstanceOf(Message);
    });
  });

  describe('estimateTokenCount', () => {
    it('should estimate tokens for simple messages', () => {
      const messages = [Message.user('Hello world'), Message.assistant('Hi there!')];
      const count = estimateTokenCount(messages);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(50); // Should be reasonable estimate
    });

    it('should add extra tokens for tool calls', () => {
      const toolCalls = [new ToolCall('1', 'test', {})];
      const messageWithTools = Message.assistantWithToolCalls('Hello', toolCalls);
      const messageWithoutTools = Message.assistant('Hello');

      const countWithTools = estimateTokenCount([messageWithTools]);
      const countWithoutTools = estimateTokenCount([messageWithoutTools]);

      expect(countWithTools).toBeGreaterThan(countWithoutTools);
    });

    it('should add extra tokens for images', () => {
      const messageWithImage = Message.userWithImage('Look', 'https://example.com/img.jpg');
      const messageWithoutImage = Message.user('Look');

      const countWithImage = estimateTokenCount([messageWithImage]);
      const countWithoutImage = estimateTokenCount([messageWithoutImage]);

      expect(countWithImage).toBeGreaterThan(countWithoutImage);
    });
  });
});
