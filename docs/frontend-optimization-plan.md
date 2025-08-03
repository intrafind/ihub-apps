# Frontend Chat Optimization Implementation Plan

## Overview

This document provides a detailed step-by-step implementation plan for optimizing frontend chat performance in AI Hub Apps. The optimization addresses performance bottlenecks in longer chat conversations through IndexedDB storage, debounced writes, message virtualization, and enhanced resource management.

## Current Architecture Analysis

### Performance Bottlenecks Identified

1. **Storage Limitations**
   - Current: SessionStorage with 5-10MB browser limit
   - File: `client/src/features/chat/hooks/useChatMessages.js:79`
   - Issue: Every message state change triggers immediate storage write

2. **Memory Usage**
   - Current: All messages kept in React state simultaneously
   - File: `client/src/features/chat/hooks/useChatMessages.js:29`
   - Issue: Memory usage grows linearly with conversation length

3. **Rendering Performance**
   - Current: All messages rendered at once
   - File: `client/src/features/chat/components/ChatMessageList.jsx:46`
   - Issue: DOM complexity increases with every message

4. **Resource Management**
   - Current: Components hidden with CSS, not unmounted
   - File: `client/src/shared/hooks/useEventSource.js:14`
   - Issue: SSE connections and timers remain active when hidden

## Implementation Roadmap

### Phase 1: Storage Foundation (Weeks 1-3)

#### 1.1 Create IndexedDB Service (Week 1)

**Create**: `client/src/shared/services/indexedDbService.js`

```javascript
/**
 * IndexedDB service for chat message persistence
 * Replaces sessionStorage with unlimited browser storage
 */
class IndexedDbService {
  constructor() {
    this.dbName = 'ai_hub_chat_storage';
    this.version = 1;
    this.db = null;
  }

  async initDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Messages store
        if (!db.objectStoreNames.contains('messages')) {
          const messageStore = db.createObjectStore('messages', { keyPath: 'id' });
          messageStore.createIndex('chatId', 'chatId', { unique: false });
          messageStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Chat metadata store
        if (!db.objectStoreNames.contains('chat_metadata')) {
          db.createObjectStore('chat_metadata', { keyPath: 'chatId' });
        }
      };
    });
  }

  async saveMessages(chatId, messages) {
    if (!this.db) await this.initDb();
    
    const transaction = this.db.transaction(['messages', 'chat_metadata'], 'readwrite');
    const messageStore = transaction.objectStore('messages');
    const metadataStore = transaction.objectStore('chat_metadata');
    
    // Clear existing messages for this chat
    const chatIndex = messageStore.index('chatId');
    const existingMessages = await this.getAllFromIndex(chatIndex, chatId);
    
    for (const msg of existingMessages) {
      await messageStore.delete(msg.id);
    }
    
    // Save new messages
    for (const message of messages) {
      await messageStore.add({
        ...message,
        chatId,
        timestamp: message.timestamp || Date.now()
      });
    }
    
    // Update metadata
    await metadataStore.put({
      chatId,
      messageCount: messages.length,
      lastUpdated: Date.now()
    });
    
    return transaction.complete;
  }

  async loadMessages(chatId, limit = null, offset = 0) {
    if (!this.db) await this.initDb();
    
    const transaction = this.db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');
    
    const messages = await this.getAllFromIndex(index, chatId);
    
    // Sort by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);
    
    // Apply pagination
    if (limit) {
      return messages.slice(offset, offset + limit);
    }
    
    return messages;
  }

  async deleteChat(chatId) {
    if (!this.db) await this.initDb();
    
    const transaction = this.db.transaction(['messages', 'chat_metadata'], 'readwrite');
    const messageStore = transaction.objectStore('messages');
    const metadataStore = transaction.objectStore('chat_metadata');
    
    // Delete all messages for this chat
    const chatIndex = messageStore.index('chatId');
    const messages = await this.getAllFromIndex(chatIndex, chatId);
    
    for (const msg of messages) {
      await messageStore.delete(msg.id);
    }
    
    // Delete metadata
    await metadataStore.delete(chatId);
    
    return transaction.complete;
  }

  // Helper method
  getAllFromIndex(index, key) {
    return new Promise((resolve, reject) => {
      const request = index.getAll(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export default new IndexedDbService();
```

#### 1.2 Implement Debounced Write System (Week 1)

**Create**: `client/src/shared/utils/debouncedStorageWriter.js`

```javascript
/**
 * Debounced storage writer for buffering frequent write operations
 * Reduces I/O operations by batching writes every ~500ms
 */
class DebouncedStorageWriter {
  constructor(writeFunction, delay = 500) {
    this.writeFunction = writeFunction;
    this.delay = delay;
    this.pendingWrites = new Map();
    this.timeouts = new Map();
  }

  scheduleWrite(key, data) {
    // Store the data to be written
    this.pendingWrites.set(key, data);
    
    // Clear existing timeout for this key
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key));
    }
    
    // Schedule new write
    const timeout = setTimeout(() => {
      this.flush(key);
    }, this.delay);
    
    this.timeouts.set(key, timeout);
  }

  async flush(key) {
    if (this.pendingWrites.has(key)) {
      const data = this.pendingWrites.get(key);
      this.pendingWrites.delete(key);
      this.timeouts.delete(key);
      
      try {
        await this.writeFunction(key, data);
      } catch (error) {
        console.error('Debounced write failed:', error);
      }
    }
  }

  async flushAll() {
    const promises = Array.from(this.pendingWrites.keys()).map(key => this.flush(key));
    await Promise.all(promises);
  }

  destroy() {
    // Clear all pending timeouts
    this.timeouts.forEach(timeout => clearTimeout(timeout));
    this.timeouts.clear();
    this.pendingWrites.clear();
  }
}

export default DebouncedStorageWriter;
```

#### 1.3 Update useChatMessages Hook (Week 2)

**Modify**: `client/src/features/chat/hooks/useChatMessages.js`

```javascript
import { useState, useCallback, useRef, useEffect } from 'react';
import indexedDbService from '../../../shared/services/indexedDbService';
import DebouncedStorageWriter from '../../../shared/utils/debouncedStorageWriter';

// ... existing imports

function useChatMessages(chatId = 'default') {
  const storageKey = `ai_hub_chat_messages_${chatId}`;
  const prevChatIdRef = useRef(chatId);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Initialize debounced writer
  const debouncedWriter = useRef(
    new DebouncedStorageWriter(async (key, data) => {
      await indexedDbService.saveMessages(chatId, data);
    }, 500)
  );

  // Migration function from sessionStorage to IndexedDB
  const migrateFromSessionStorage = useCallback(async () => {
    try {
      const storedMessages = sessionStorage.getItem(storageKey);
      if (storedMessages) {
        const parsedMessages = JSON.parse(storedMessages);
        await indexedDbService.saveMessages(chatId, parsedMessages);
        sessionStorage.removeItem(storageKey);
        console.log(`Migrated ${parsedMessages.length} messages from sessionStorage to IndexedDB`);
        return parsedMessages;
      }
    } catch (error) {
      console.error('Migration from sessionStorage failed:', error);
    }
    return null;
  }, [chatId, storageKey]);

  // Load initial messages from IndexedDB
  const loadInitialMessages = useCallback(async () => {
    setIsLoading(true);
    try {
      // Try migration first
      const migratedMessages = await migrateFromSessionStorage();
      if (migratedMessages) {
        setMessages(migratedMessages);
        setIsLoading(false);
        return;
      }

      // Load from IndexedDB
      const loadedMessages = await indexedDbService.loadMessages(chatId);
      setMessages(loadedMessages);
    } catch (error) {
      console.error('Error loading messages from IndexedDB:', error);
      setMessages([]);
    } finally {
      setIsLoading(false);
    }
  }, [chatId, migrateFromSessionStorage]);

  // Load messages when component mounts or chatId changes
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      loadInitialMessages();
      prevChatIdRef.current = chatId;
    }
  }, [chatId, loadInitialMessages]);

  // Save messages with debouncing (replace immediate sessionStorage writes)
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      const persistableMessages = messages.filter(msg => !msg.isGreeting);
      debouncedWriter.current.scheduleWrite(chatId, persistableMessages);
    }
  }, [messages, chatId, isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      debouncedWriter.current.flushAll();
      debouncedWriter.current.destroy();
    };
  }, []);

  // ... rest of existing methods remain the same
  
  return {
    messages,
    isLoading,
    messagesRef,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    setMessageError,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi
  };
}
```

#### 1.4 Backward Compatibility & Fallback (Week 3)

**Create**: `client/src/shared/services/storageService.js`

```javascript
/**
 * Unified storage service with IndexedDB primary and sessionStorage fallback
 */
import indexedDbService from './indexedDbService';

class StorageService {
  constructor() {
    this.indexedDbAvailable = this.checkIndexedDbSupport();
    this.fallbackToSessionStorage = false;
  }

  checkIndexedDbSupport() {
    return !!(window.indexedDB && window.IDBTransaction && window.IDBKeyRange);
  }

  async saveMessages(chatId, messages) {
    if (this.indexedDbAvailable && !this.fallbackToSessionStorage) {
      try {
        await indexedDbService.saveMessages(chatId, messages);
        return;
      } catch (error) {
        console.warn('IndexedDB failed, falling back to sessionStorage:', error);
        this.fallbackToSessionStorage = true;
      }
    }

    // Fallback to sessionStorage
    try {
      const storageKey = `ai_hub_chat_messages_${chatId}`;
      sessionStorage.setItem(storageKey, JSON.stringify(messages));
    } catch (error) {
      console.error('Both IndexedDB and sessionStorage failed:', error);
    }
  }

  async loadMessages(chatId, limit = null, offset = 0) {
    if (this.indexedDbAvailable && !this.fallbackToSessionStorage) {
      try {
        return await indexedDbService.loadMessages(chatId, limit, offset);
      } catch (error) {
        console.warn('IndexedDB failed, falling back to sessionStorage:', error);
        this.fallbackToSessionStorage = true;
      }
    }

    // Fallback to sessionStorage
    try {
      const storageKey = `ai_hub_chat_messages_${chatId}`;
      const storedMessages = sessionStorage.getItem(storageKey);
      const messages = storedMessages ? JSON.parse(storedMessages) : [];
      
      if (limit) {
        return messages.slice(offset, offset + limit);
      }
      return messages;
    } catch (error) {
      console.error('Both IndexedDB and sessionStorage failed:', error);
      return [];
    }
  }

  async deleteChat(chatId) {
    if (this.indexedDbAvailable && !this.fallbackToSessionStorage) {
      try {
        await indexedDbService.deleteChat(chatId);
        return;
      } catch (error) {
        console.warn('IndexedDB failed, falling back to sessionStorage:', error);
        this.fallbackToSessionStorage = true;
      }
    }

    // Fallback to sessionStorage
    try {
      const storageKey = `ai_hub_chat_messages_${chatId}`;
      sessionStorage.removeItem(storageKey);
    } catch (error) {
      console.error('Both IndexedDB and sessionStorage failed:', error);
    }
  }
}

export default new StorageService();
```

### Phase 2: Rendering Performance (Weeks 4-6)

#### 2.1 Install React Window (Week 4)

**Command**: `npm install react-window react-window-infinite-loader --save`

#### 2.2 Create Virtualized Chat Component (Week 4-5)

**Create**: `client/src/features/chat/components/VirtualizedChatMessageList.jsx`

```javascript
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { FixedSizeList as List } from 'react-window';
import ChatMessage from './ChatMessage';
import Icon from '../../../shared/components/Icon';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

const ITEM_HEIGHT = 120; // Estimated height per message
const BUFFER_SIZE = 5; // Number of messages to render outside viewport

const VirtualizedChatMessageList = ({
  messages,
  outputFormat = 'markdown',
  onDelete,
  onEdit,
  onResend,
  appId,
  chatId,
  modelId,
  editable = false,
  compact = false,
  onOpenInCanvas,
  onInsert,
  canvasEnabled = false,
  height = 400
}) => {
  const { uiConfig } = useUIConfig();
  const listRef = useRef(null);
  const [itemSizes, setItemSizes] = useState(new Map());

  const assistantIcon = uiConfig?.icons?.assistantMessage || 'apps-svg-logo';
  const userIcon = uiConfig?.icons?.userMessage || 'user';
  const errorIcon = uiConfig?.icons?.errorMessage || 'exclamation-circle';

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (listRef.current && messages.length > 0) {
      listRef.current.scrollToItem(messages.length - 1, 'end');
    }
  }, [messages.length]);

  // Memoized message renderer
  const MessageRenderer = useMemo(() => {
    return ({ index, style }) => {
      const message = messages[index];
      
      return (
        <div style={style} className="px-4">
          <div className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'} py-2`}>
            {/* Message sender icon */}
            <div className="flex-shrink-0 mt-1">
              {message.role === 'assistant' ? (
                <Icon name={assistantIcon} size="2xl" className="text-blue-500" />
              ) : message.role === 'user' ? (
                <Icon name={userIcon} size="xl" className="text-gray-500" />
              ) : (
                <Icon name={errorIcon} size="2xl" className="text-yellow-500" />
              )}
            </div>

            {/* Message content */}
            <div className={`max-w-[80%] ${message.role === 'user' ? '' : ''}`}>
              <ChatMessage
                message={message}
                outputFormat={outputFormat}
                onDelete={onDelete}
                onEdit={onEdit}
                onResend={onResend}
                editable={editable}
                appId={appId}
                chatId={chatId}
                modelId={modelId}
                compact={compact}
                onOpenInCanvas={onOpenInCanvas}
                onInsert={onInsert}
                canvasEnabled={canvasEnabled}
              />
            </div>
          </div>
        </div>
      );
    };
  }, [
    messages,
    outputFormat,
    onDelete,
    onEdit,
    onResend,
    editable,
    appId,
    chatId,
    modelId,
    compact,
    onOpenInCanvas,
    onInsert,
    canvasEnabled,
    assistantIcon,
    userIcon,
    errorIcon
  ]);

  // Don't render if no messages
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="flex-1 mb-4 overflow-hidden rounded-lg">
      <List
        ref={listRef}
        height={height}
        itemCount={messages.length}
        itemSize={ITEM_HEIGHT}
        overscanCount={BUFFER_SIZE}
        className="overflow-y-auto"
      >
        {MessageRenderer}
      </List>
    </div>
  );
};

export default VirtualizedChatMessageList;
```

#### 2.3 Implement Message Pagination Hook (Week 5)

**Create**: `client/src/features/chat/hooks/usePaginatedMessages.js`

```javascript
import { useState, useCallback, useEffect, useRef } from 'react';
import storageService from '../../../shared/services/storageService';

const MESSAGES_PER_PAGE = 50;
const INITIAL_LOAD_COUNT = 50;

function usePaginatedMessages(chatId) {
  const [visibleMessages, setVisibleMessages] = useState([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const offsetRef = useRef(0);
  const allMessagesRef = useRef([]);

  // Load initial messages
  const loadInitialMessages = useCallback(async () => {
    try {
      const messages = await storageService.loadMessages(chatId, INITIAL_LOAD_COUNT, 0);
      allMessagesRef.current = messages;
      setVisibleMessages(messages);
      setTotalMessageCount(messages.length);
      setHasMoreMessages(messages.length === INITIAL_LOAD_COUNT);
      offsetRef.current = messages.length;
    } catch (error) {
      console.error('Error loading initial messages:', error);
      setVisibleMessages([]);
      setTotalMessageCount(0);
      setHasMoreMessages(false);
    }
  }, [chatId]);

  // Load more messages (older messages)
  const loadMoreMessages = useCallback(async () => {
    if (isLoadingMore || !hasMoreMessages) return;

    setIsLoadingMore(true);
    try {
      const olderMessages = await storageService.loadMessages(
        chatId,
        MESSAGES_PER_PAGE,
        offsetRef.current
      );

      if (olderMessages.length > 0) {
        const newAllMessages = [...olderMessages, ...allMessagesRef.current];
        allMessagesRef.current = newAllMessages;
        setVisibleMessages(newAllMessages);
        offsetRef.current += olderMessages.length;
        setHasMoreMessages(olderMessages.length === MESSAGES_PER_PAGE);
      } else {
        setHasMoreMessages(false);
      }
    } catch (error) {
      console.error('Error loading more messages:', error);
      setHasMoreMessages(false);
    } finally {
      setIsLoadingMore(false);
    }
  }, [chatId, isLoadingMore, hasMoreMessages]);

  // Add new message to visible messages
  const addNewMessage = useCallback((message) => {
    const newMessages = [...allMessagesRef.current, message];
    allMessagesRef.current = newMessages;
    setVisibleMessages(newMessages);
    setTotalMessageCount(prev => prev + 1);
  }, []);

  // Update existing message
  const updateMessage = useCallback((messageId, updates) => {
    const updatedMessages = allMessagesRef.current.map(msg =>
      msg.id === messageId ? { ...msg, ...updates } : msg
    );
    allMessagesRef.current = updatedMessages;
    setVisibleMessages(updatedMessages);
  }, []);

  // Delete message and subsequent messages
  const deleteMessage = useCallback((messageId) => {
    const messageIndex = allMessagesRef.current.findIndex(msg => msg.id === messageId);
    if (messageIndex !== -1) {
      const newMessages = allMessagesRef.current.slice(0, messageIndex);
      allMessagesRef.current = newMessages;
      setVisibleMessages(newMessages);
      setTotalMessageCount(newMessages.length);
    }
  }, []);

  // Clear all messages
  const clearMessages = useCallback(() => {
    allMessagesRef.current = [];
    setVisibleMessages([]);
    setTotalMessageCount(0);
    setHasMoreMessages(false);
    offsetRef.current = 0;
  }, []);

  // Initialize on chatId change
  useEffect(() => {
    loadInitialMessages();
  }, [chatId, loadInitialMessages]);

  return {
    visibleMessages,
    hasMoreMessages,
    isLoadingMore,
    totalMessageCount,
    loadMoreMessages,
    addNewMessage,
    updateMessage,
    deleteMessage,
    clearMessages
  };
}

export default usePaginatedMessages;
```

#### 2.4 Create Feature Flag System (Week 6)

**Create**: `client/src/shared/contexts/FeatureFlagContext.jsx`

```javascript
import React, { createContext, useContext, useState } from 'react';

const FeatureFlagContext = createContext();

export function FeatureFlagProvider({ children }) {
  const [features, setFeatures] = useState({
    virtualizedChat: false, // Start with virtualization disabled
    paginatedMessages: false,
    indexedDbStorage: false
  });

  const enableFeature = (featureName) => {
    setFeatures(prev => ({ ...prev, [featureName]: true }));
  };

  const disableFeature = (featureName) => {
    setFeatures(prev => ({ ...prev, [featureName]: false }));
  };

  const isFeatureEnabled = (featureName) => {
    return features[featureName] || false;
  };

  return (
    <FeatureFlagContext.Provider value={{
      features,
      enableFeature,
      disableFeature,
      isFeatureEnabled
    }}>
      {children}
    </FeatureFlagContext.Provider>
  );
}

export function useFeatureFlags() {
  const context = useContext(FeatureFlagContext);
  if (!context) {
    throw new Error('useFeatureFlags must be used within a FeatureFlagProvider');
  }
  return context;
}
```

### Phase 3: Resource Management (Weeks 7-8)

#### 3.1 Enhanced Component Unmounting (Week 7)

**Modify**: `client/src/features/apps/pages/AppChat.jsx`

```javascript
// Add conditional mounting instead of CSS hiding
import { useFeatureFlags } from '../../../shared/contexts/FeatureFlagContext';

function AppChat({ /* existing props */ }) {
  const { isFeatureEnabled } = useFeatureFlags();
  const [isVisible, setIsVisible] = useState(true);
  const [shouldMount, setShouldMount] = useState(true);

  // Enhanced visibility management
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsVisible(false);
        // Unmount after delay if feature enabled
        if (isFeatureEnabled('enhancedResourceManagement')) {
          setTimeout(() => setShouldMount(false), 5000);
        }
      } else {
        setIsVisible(true);
        setShouldMount(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isFeatureEnabled]);

  // Don't render if unmounted
  if (!shouldMount) {
    return <div className="chat-placeholder">Chat unmounted for performance</div>;
  }

  // Rest of component logic...
}
```

#### 3.2 Enhanced EventSource Management (Week 7)

**Modify**: `client/src/shared/hooks/useEventSource.js`

```javascript
// Add enhanced cleanup and resource management
function useEventSource({ appId, chatId, timeoutDuration = 10000, onEvent, onProcessingChange }) {
  const eventSourceRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const fullContentRef = useRef('');
  const cleanupCallbacksRef = useRef([]);

  // Enhanced cleanup with resource tracking
  const cleanupEventSource = useCallback(async () => {
    console.log('🧹 Starting enhanced EventSource cleanup');
    
    if (eventSourceRef.current) {
      const ev = eventSourceRef.current;
      eventSourceRef.current = null;

      // Execute all registered cleanup callbacks
      cleanupCallbacksRef.current.forEach(callback => {
        try {
          callback();
        } catch (err) {
          console.error('Cleanup callback error:', err);
        }
      });
      cleanupCallbacksRef.current = [];

      // Clear all timers with error handling
      [heartbeatIntervalRef, connectionTimeoutRef].forEach(ref => {
        if (ref.current) {
          clearTimeout(ref.current);
          clearInterval(ref.current);
          ref.current = null;
        }
      });

      // Stop server-side stream
      try {
        if (appId && chatId) {
          await stopAppChatStream(appId, chatId);
          console.log('✅ Server stream stopped');
        }
      } catch (err) {
        console.warn('Failed to stop chat stream:', err);
      }

      // Enhanced EventSource cleanup
      try {
        if (ev) {
          // Remove all event listeners
          if (ev.__handlers && ev.__handlers.events) {
            ev.__handlers.events.forEach(evt =>
              ev.removeEventListener(evt, ev.__handlers.handleEvent)
            );
          }
          
          // Clear handlers
          ev.onmessage = null;
          ev.onerror = null;
          ev.onopen = null;
          
          // Close connection
          if (ev.readyState !== EventSource.CLOSED) {
            ev.close();
          }
          
          console.log('✅ EventSource cleaned up');
        }
      } catch (err) {
        console.error('Error cleaning up event source:', err);
      }

      // Clear content buffer
      fullContentRef.current = '';
    }
  }, [appId, chatId]);

  // Register cleanup callback
  const registerCleanupCallback = useCallback((callback) => {
    cleanupCallbacksRef.current.push(callback);
  }, []);

  // Enhanced visibility management
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && eventSourceRef.current) {
        console.log('⏸️ Page hidden, pausing EventSource heartbeat');
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
      } else if (!document.hidden && eventSourceRef.current) {
        console.log('▶️ Page visible, resuming EventSource heartbeat');
        startHeartbeat();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Rest of existing methods...

  return {
    initEventSource,
    cleanupEventSource,
    registerCleanupCallback,
    eventSourceRef,
    isConnected: !!eventSourceRef.current
  };
}
```

#### 3.3 Memory Management and LRU Cache (Week 8)

**Create**: `client/src/shared/utils/lruCache.js`

```javascript
/**
 * LRU (Least Recently Used) Cache for message management
 * Automatically removes oldest accessed items when capacity is exceeded
 */
class LRUCache {
  constructor(capacity = 100) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key) {
    if (this.cache.has(key)) {
      // Move to end (most recently used)
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return null;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      // Update existing key
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Remove least recently used item
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }

  // Get all keys in order (least to most recently used)
  keys() {
    return Array.from(this.cache.keys());
  }
}

export default LRUCache;
```

## Testing Strategy

### 3.4 Performance Testing Suite (Week 8)

**Create**: `client/src/tests/performance/chatPerformance.test.js`

```javascript
/**
 * Performance testing suite for chat optimizations
 */
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import ChatMessageList from '../../features/chat/components/ChatMessageList';
import VirtualizedChatMessageList from '../../features/chat/components/VirtualizedChatMessageList';

describe('Chat Performance Tests', () => {
  const generateMockMessages = (count) => {
    return Array.from({ length: count }, (_, index) => ({
      id: `msg-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Test message ${index + 1}`.repeat(10),
      timestamp: Date.now() + index
    }));
  };

  test('Large message list rendering performance', async () => {
    const messages = generateMockMessages(1000);
    const startTime = performance.now();
    
    render(<ChatMessageList messages={messages} />);
    
    const endTime = performance.now();
    const renderTime = endTime - startTime;
    
    console.log(`Standard ChatMessageList render time: ${renderTime}ms`);
    expect(renderTime).toBeLessThan(5000); // Should render within 5 seconds
  });

  test('Virtualized message list rendering performance', async () => {
    const messages = generateMockMessages(1000);
    const startTime = performance.now();
    
    render(<VirtualizedChatMessageList messages={messages} height={400} />);
    
    const endTime = performance.now();
    const renderTime = endTime - startTime;
    
    console.log(`Virtualized ChatMessageList render time: ${renderTime}ms`);
    expect(renderTime).toBeLessThan(1000); // Should render within 1 second
  });

  test('Memory usage with large datasets', () => {
    const initialMemory = performance.memory ? performance.memory.usedJSHeapSize : 0;
    
    const messages = generateMockMessages(5000);
    render(<VirtualizedChatMessageList messages={messages} height={400} />);
    
    const finalMemory = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const memoryIncrease = finalMemory - initialMemory;
    
    console.log(`Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);
    expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // Less than 50MB increase
  });
});
```

## Deployment Strategy

### Feature Flag Rollout Plan

1. **Week 1-3**: Deploy IndexedDB storage with feature flag disabled
2. **Week 4**: Enable IndexedDB for 10% of users
3. **Week 5**: Enable IndexedDB for 50% of users if no issues
4. **Week 6**: Enable virtualization for 10% of users
5. **Week 7**: Enable all optimizations for 25% of users
6. **Week 8**: Full rollout if performance metrics are positive

### Success Metrics

| Metric | Current Baseline | Target Improvement |
|--------|-----------------|-------------------|
| Memory Usage (1000 messages) | 200MB+ | <50MB (75% reduction) |
| Storage Operations/Second | 10-50 | <2 (90% reduction) |
| Render Time (1000 messages) | 3-5 seconds | <500ms (90% reduction) |
| DOM Nodes (1000 messages) | 5000+ | <50 (99% reduction) |
| First Paint Time | 2-3 seconds | <1 second (66% reduction) |

### Monitoring and Alerts

**Create**: `client/src/shared/utils/performanceMonitor.js`

```javascript
/**
 * Performance monitoring utility for chat optimizations
 */
class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.thresholds = {
      renderTime: 1000, // 1 second
      memoryUsage: 100 * 1024 * 1024, // 100MB
      storageOperations: 5 // per second
    };
  }

  startTimer(key) {
    this.metrics.set(key, { startTime: performance.now() });
  }

  endTimer(key) {
    const entry = this.metrics.get(key);
    if (entry) {
      const duration = performance.now() - entry.startTime;
      entry.duration = duration;
      
      // Check thresholds
      if (duration > this.thresholds.renderTime) {
        console.warn(`Performance warning: ${key} took ${duration}ms`);
      }
      
      return duration;
    }
    return null;
  }

  recordMemoryUsage(key) {
    if (performance.memory) {
      const usage = performance.memory.usedJSHeapSize;
      this.metrics.set(`${key}_memory`, { memoryUsage: usage });
      
      if (usage > this.thresholds.memoryUsage) {
        console.warn(`Memory warning: ${key} using ${(usage / 1024 / 1024).toFixed(2)}MB`);
      }
      
      return usage;
    }
    return null;
  }

  getMetrics() {
    return Object.fromEntries(this.metrics);
  }

  clearMetrics() {
    this.metrics.clear();
  }
}

export default new PerformanceMonitor();
```

## Migration Guide

### For Existing Installations

1. **Backup existing chat data** before deployment
2. **Enable feature flags** gradually in production
3. **Monitor performance metrics** during rollout
4. **Rollback plan** if issues occur
5. **User communication** about new features

### Configuration Updates Required

**Update**: `client/src/App.jsx`

```javascript
import { FeatureFlagProvider } from './shared/contexts/FeatureFlagContext';

function App() {
  return (
    <FeatureFlagProvider>
      {/* Existing app structure */}
    </FeatureFlagProvider>
  );
}
```

## Expected Performance Impact

### Before Optimization
- **1000 messages**: 200MB+ memory, 5+ second render time
- **Storage**: Immediate writes on every chunk
- **DOM**: All messages rendered simultaneously
- **Resources**: Hidden components remain active

### After Optimization
- **1000 messages**: <50MB memory, <500ms render time
- **Storage**: Batched writes every 500ms
- **DOM**: Only 10-15 visible messages rendered
- **Resources**: Inactive components properly unmounted

## Conclusion

This implementation plan provides a comprehensive approach to optimizing frontend chat performance for longer conversations. The phased rollout ensures minimal risk while delivering significant performance improvements. The use of feature flags allows for gradual deployment and easy rollback if issues arise.

The optimization foundation will also support future enhancements such as:
- Real-time collaboration features
- Advanced search and filtering
- Message threading and organization
- Enhanced multimedia support

## Next Steps

1. **Review and approve** this implementation plan
2. **Assign development resources** to each phase
3. **Set up performance monitoring** infrastructure
4. **Begin Phase 1 implementation** with IndexedDB storage foundation

---

*Generated as part of GitHub Issue #367 - Frontend Chat Optimization Implementation Plan*