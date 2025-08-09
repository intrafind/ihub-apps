import { test, expect } from '@playwright/test';

/**
 * End-to-End Tests for Chat Functionality
 * These tests validate the complete user journey for chat interactions
 */

test.describe('Chat E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the application
    await page.goto('/');

    // Wait for the application to load
    await page.waitForLoadState('networkidle');
  });

  test('should load the chat interface', async ({ page }) => {
    // Check if the main chat interface elements are present
    await expect(page.locator('[data-testid="chat-container"]')).toBeVisible();
    await expect(page.locator('[data-testid="message-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
  });

  test('should display available apps', async ({ page }) => {
    // Check if apps are displayed
    await expect(page.locator('[data-testid="app-selector"]')).toBeVisible();

    // Verify at least one app is available
    const appCount = await page.locator('[data-testid="app-option"]').count();
    expect(appCount).toBeGreaterThan(0);
  });

  test('should send a message and receive a response', async ({ page }) => {
    // Select an app (if not already selected)
    const appSelector = page.locator('[data-testid="app-selector"]');
    if (await appSelector.isVisible()) {
      await page.locator('[data-testid="app-option"]').first().click();
    }

    // Type a message
    const messageInput = page.locator('[data-testid="message-input"]');
    await messageInput.fill('Hello, this is a test message');

    // Send the message
    await page.locator('[data-testid="send-button"]').click();

    // Wait for the message to appear in the chat
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText(
      'Hello, this is a test message'
    );

    // Wait for the assistant response (with timeout)
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({
      timeout: 30000
    });

    // Verify the response contains some content
    const responseText = await page
      .locator('[data-testid="assistant-message"]')
      .last()
      .textContent();
    expect(responseText).toBeTruthy();
    expect(responseText.length).toBeGreaterThan(0);
  });

  test('should handle tool calling functionality', async ({ page }) => {
    // Select an app that supports tools
    await page.locator('[data-testid="app-selector"]').click();
    await page.locator('[data-testid="app-option"][data-supports-tools="true"]').first().click();

    // Send a message that should trigger tool usage
    const messageInput = page.locator('[data-testid="message-input"]');
    await messageInput.fill('Search for information about artificial intelligence');
    await page.locator('[data-testid="send-button"]').click();

    // Wait for tool execution indicator
    await expect(page.locator('[data-testid="tool-execution-indicator"]')).toBeVisible({
      timeout: 10000
    });

    // Wait for the final response
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({
      timeout: 60000
    });

    // Verify tool call results are displayed
    await expect(page.locator('[data-testid="tool-result"]')).toBeVisible();
  });

  test('should maintain conversation history', async ({ page }) => {
    // Send first message
    await page.locator('[data-testid="message-input"]').fill('What is machine learning?');
    await page.locator('[data-testid="send-button"]').click();

    // Wait for response
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({
      timeout: 30000
    });

    // Send follow-up message
    await page.locator('[data-testid="message-input"]').fill('Can you give me an example?');
    await page.locator('[data-testid="send-button"]').click();

    // Wait for second response
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({
      timeout: 30000
    });

    // Verify conversation history
    const userMessages = await page.locator('[data-testid="user-message"]').count();
    const assistantMessages = await page.locator('[data-testid="assistant-message"]').count();

    expect(userMessages).toBe(2);
    expect(assistantMessages).toBe(2);
  });

  test('should handle authentication flow', async ({ page }) => {
    // Check if authentication is required
    const loginButton = page.locator('[data-testid="login-button"]');

    if (await loginButton.isVisible()) {
      // Test login flow
      await loginButton.click();

      // Fill login form (adjust selectors based on your auth implementation)
      await page.locator('[data-testid="username-input"]').fill('test.user@ihub.com');
      await page.locator('[data-testid="password-input"]').fill('testpassword');
      await page.locator('[data-testid="submit-login"]').click();

      // Wait for successful login
      await expect(page.locator('[data-testid="user-profile"]')).toBeVisible({ timeout: 10000 });
    }

    // Verify user can access chat after authentication
    await expect(page.locator('[data-testid="chat-container"]')).toBeVisible();
  });

  test('should be responsive on mobile devices', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Check if mobile layout is applied
    await expect(page.locator('[data-testid="mobile-menu-toggle"]')).toBeVisible();

    // Test mobile chat functionality
    await page.locator('[data-testid="message-input"]').fill('Mobile test message');
    await page.locator('[data-testid="send-button"]').click();

    // Verify mobile layout maintains functionality
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText(
      'Mobile test message'
    );
  });

  test('should handle error states gracefully', async ({ page }) => {
    // Mock network failure
    await page.route('/api/chat/**', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' })
      });
    });

    // Try to send a message
    await page.locator('[data-testid="message-input"]').fill('This should fail');
    await page.locator('[data-testid="send-button"]').click();

    // Check for error message
    await expect(page.locator('[data-testid="error-message"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="error-message"]')).toContainText('error');
  });

  test('should support file uploads', async ({ page }) => {
    // Check if file upload is available
    const fileInput = page.locator('[data-testid="file-upload-input"]');

    if (await fileInput.isVisible()) {
      // Upload a test file
      await fileInput.setInputFiles('tests/fixtures/test-document.pdf');

      // Verify file is uploaded
      await expect(page.locator('[data-testid="uploaded-file"]')).toBeVisible();

      // Send a message about the file
      await page.locator('[data-testid="message-input"]').fill('What does this document contain?');
      await page.locator('[data-testid="send-button"]').click();

      // Wait for response that references the file
      await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({
        timeout: 60000
      });
    }
  });

  test('should support streaming responses', async ({ page }) => {
    // Send a message that generates a long response
    await page
      .locator('[data-testid="message-input"]')
      .fill('Write a detailed explanation of quantum computing');
    await page.locator('[data-testid="send-button"]').click();

    // Check for streaming indicator
    await expect(page.locator('[data-testid="typing-indicator"]')).toBeVisible({ timeout: 5000 });

    // Wait for streaming to complete
    await expect(page.locator('[data-testid="typing-indicator"]')).toBeHidden({ timeout: 60000 });

    // Verify complete response is displayed
    const responseText = await page
      .locator('[data-testid="assistant-message"]')
      .last()
      .textContent();
    expect(responseText.length).toBeGreaterThan(100); // Expecting a substantial response
  });
});
