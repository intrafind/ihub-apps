/* global Office */

// API URL will be auto-configured from the server
let API_URL = '';

// Try to get API URL from window location or config endpoint
async function initializeApiUrl() {
  try {
    // First try to get from current page's origin
    const currentOrigin = window.location.origin;

    // Check if we're loaded from the iHub server
    if (currentOrigin && !currentOrigin.includes('localhost')) {
      API_URL = currentOrigin;
      console.log('API URL auto-detected:', API_URL);

      // Save to localStorage
      localStorage.setItem('ihub_api_url', API_URL);

      // Update UI
      const apiUrlInput = document.getElementById('apiUrl');
      if (apiUrlInput) {
        apiUrlInput.value = API_URL;
      }

      return API_URL;
    }

    // Fall back to localStorage if available
    const savedUrl = localStorage.getItem('ihub_api_url');
    if (savedUrl) {
      API_URL = savedUrl;
      console.log('API URL from localStorage:', API_URL);
      return API_URL;
    }

    // If nothing works, user will need to configure manually
    console.log('API URL not configured - user must enter manually');
  } catch (error) {
    console.error('Error initializing API URL:', error);
  }

  return API_URL;
}

// Initialize Office.js
Office.onReady(async info => {
  if (info.host === Office.HostType.Outlook) {
    console.log('iHub Outlook Add-in initialized');

    // Initialize API URL
    await initializeApiUrl();

    // Load saved settings
    loadSettings();

    // Set up event listeners
    document.getElementById('summarizeBtn').addEventListener('click', summarizeEmail);
    document.getElementById('replyBtn').addEventListener('click', generateReply);
    document.getElementById('analyzeAttachmentsBtn').addEventListener('click', analyzeAttachments);
    document.getElementById('copyBtn').addEventListener('click', copyToClipboard);
    document.getElementById('apiUrl').addEventListener('change', saveApiUrl);

    // Check URL parameter for action
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    if (action === 'summarize') {
      setTimeout(() => summarizeEmail(), 500);
    } else if (action === 'reply') {
      setTimeout(() => generateReply(), 500);
    }
  }
});

/**
 * Load settings from Office.js settings
 */
function loadSettings() {
  try {
    const apiUrlInput = document.getElementById('apiUrl');
    const savedUrl = localStorage.getItem('ihub_api_url');
    if (savedUrl) {
      API_URL = savedUrl;
      apiUrlInput.value = savedUrl;
    } else {
      apiUrlInput.value = API_URL;
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

/**
 * Save API URL to localStorage
 */
function saveApiUrl() {
  const apiUrlInput = document.getElementById('apiUrl');
  API_URL = apiUrlInput.value.trim();
  if (API_URL) {
    localStorage.setItem('ihub_api_url', API_URL);
    showStatus('Configuration saved', 'success');
  }
}

/**
 * Get email content from current message
 */
async function getEmailContent() {
  return new Promise((resolve, reject) => {
    Office.context.mailbox.item.body.getAsync(Office.CoercionType.Text, result => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(result.value);
      } else {
        reject(new Error('Failed to get email content'));
      }
    });
  });
}

/**
 * Get email subject
 */
function getEmailSubject() {
  return Office.context.mailbox.item.subject;
}

/**
 * Get email sender
 */
function getEmailSender() {
  const from = Office.context.mailbox.item.from;
  return from ? from.displayName || from.emailAddress : 'Unknown';
}

/**
 * Get email recipients
 */
function getEmailRecipients() {
  const to = Office.context.mailbox.item.to;
  if (to && to.length > 0) {
    return to.map(r => r.displayName || r.emailAddress).join(', ');
  }
  return 'Unknown';
}

/**
 * Get email attachments info
 */
function getAttachmentsInfo() {
  const attachments = Office.context.mailbox.item.attachments;
  if (!attachments || attachments.length === 0) {
    return null;
  }

  return attachments.map(att => ({
    name: att.name,
    type: att.contentType,
    size: att.size,
    id: att.id
  }));
}

/**
 * Summarize the current email
 */
async function summarizeEmail() {
  try {
    showStatus('Getting email content...', 'loading');
    showResult('Summarize Email', '');

    const content = await getEmailContent();
    const subject = getEmailSubject();
    const from = getEmailSender();

    if (!content || content.trim().length === 0) {
      throw new Error('Email content is empty');
    }

    showStatus('Summarizing with AI...', 'loading');

    // Prepare the request to the summarizer app
    const emailText = `Subject: ${subject}\nFrom: ${from}\n\n${content}`;

    await streamChatRequest('summarizer', emailText, {
      action: 'summarize'
    });
  } catch (error) {
    console.error('Error summarizing email:', error);
    showError('Failed to summarize email: ' + error.message);
  }
}

/**
 * Generate a reply to the current email
 */
async function generateReply() {
  try {
    showStatus('Getting email content...', 'loading');
    showResult('Generate Reply', '');

    const content = await getEmailContent();
    const subject = getEmailSubject();
    const from = getEmailSender();

    if (!content || content.trim().length === 0) {
      throw new Error('Email content is empty');
    }

    showStatus('Generating reply with AI...', 'loading');

    // Prepare the context for the email composer app
    const emailContext = `Subject: ${subject}\nFrom: ${from}\n\n${content}`;

    await streamChatRequest('email-composer', emailContext, {
      type: 'professional',
      recipient: from,
      subject: `Re: ${subject}`,
      tone: 'Use a professional tone.'
    });
  } catch (error) {
    console.error('Error generating reply:', error);
    showError('Failed to generate reply: ' + error.message);
  }
}

/**
 * Analyze email attachments
 */
async function analyzeAttachments() {
  try {
    showStatus('Checking attachments...', 'loading');
    showResult('Analyze Attachments', '');

    const attachments = getAttachmentsInfo();

    if (!attachments || attachments.length === 0) {
      showError('This email has no attachments to analyze');
      return;
    }

    const subject = getEmailSubject();
    const attachmentList = attachments
      .map(att => `- ${att.name} (${att.type}, ${formatFileSize(att.size)})`)
      .join('\n');

    showStatus('Analyzing attachments with AI...', 'loading');

    const analysisPrompt = `Email Subject: ${subject}\n\nAttachments:\n${attachmentList}\n\nPlease provide an analysis of these attachments based on their names and types.`;

    await streamChatRequest('summarizer', analysisPrompt, {
      action: 'extract the key facts from'
    });
  } catch (error) {
    console.error('Error analyzing attachments:', error);
    showError('Failed to analyze attachments: ' + error.message);
  }
}

/**
 * Stream chat request to iHub API
 */
async function streamChatRequest(appId, content, variables = {}) {
  const resultContent = document.getElementById('resultContent');
  resultContent.textContent = '';

  try {
    const apiUrl = `${API_URL}/api/chat/sessions/${appId}`;

    // Prepare the chat request
    const requestBody = {
      messages: [
        {
          role: 'user',
          content: content
        }
      ],
      variables: variables,
      streamResponse: true
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    showStatus('Receiving response...', 'loading');

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));

            if (data.content) {
              fullText += data.content;
              resultContent.textContent = fullText;
            }

            if (data.done) {
              showStatus('Complete', 'success');
              document.getElementById('copyBtn').style.display = 'inline-block';
            }

            if (data.error) {
              throw new Error(data.error);
            }
          } catch (parseError) {
            console.warn('Failed to parse SSE data:', line, parseError);
          }
        }
      }
    }

    if (fullText.trim().length === 0) {
      throw new Error('No response received from API');
    }
  } catch (error) {
    console.error('Stream request error:', error);
    showError('API Error: ' + error.message);
    throw error;
  }
}

/**
 * Show result container
 */
function showResult(title, content) {
  const resultContainer = document.getElementById('resultContainer');
  const resultTitle = document.getElementById('resultTitle');
  const resultContent = document.getElementById('resultContent');

  resultTitle.textContent = title;
  resultContent.textContent = content;
  resultContainer.classList.add('active');
  document.getElementById('copyBtn').style.display = 'none';
}

/**
 * Update status indicator
 */
function showStatus(message, type = 'loading') {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
}

/**
 * Show error message
 */
function showError(message) {
  const resultContent = document.getElementById('resultContent');
  resultContent.innerHTML = `<div class="error-message">${message}</div>`;
  showStatus('Error', 'error');
}

/**
 * Copy result to clipboard
 */
function copyToClipboard() {
  const resultContent = document.getElementById('resultContent');
  const text = resultContent.textContent;

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const copyBtn = document.getElementById('copyBtn');
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = originalText;
      }, 2000);
    })
    .catch(error => {
      console.error('Failed to copy:', error);
      showError('Failed to copy to clipboard');
    });
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  else return (bytes / 1048576).toFixed(1) + ' MB';
}
