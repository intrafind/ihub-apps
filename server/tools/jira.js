// JIRA Integration Tool
// Provides comprehensive JIRA ticket management capabilities

import JiraService from '../services/integrations/JiraService.js';

/**
 * Search and list JIRA tickets using JQL queries
 * @param {Object} params - Search parameters
 * @param {string} params.jql - JQL query to search tickets
 * @param {number} [params.maxResults=50] - Maximum number of results to return
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Search results with tickets
 */
export async function searchTickets({ jql, maxResults = 50, user }) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to search tickets',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    const results = await JiraService.searchTickets({ jql, maxResults, userId });

    return {
      success: true,
      ...results,
      message: `Found ${results.total} tickets matching your query`
    };
  } catch (error) {
    console.error('❌ Error in searchTickets:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'SEARCH_FAILED',
      message: `Failed to search JIRA tickets: ${error.message}`
    };
  }
}

/**
 * Get detailed information about a specific JIRA ticket
 * @param {Object} params - Ticket parameters
 * @param {string} params.issueKey - JIRA issue key (e.g., 'PROJ-123')
 * @param {boolean} [params.includeComments=true] - Include comments in the response
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Detailed ticket information
 */
export async function getTicket({ issueKey, includeComments = true, user }) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to view tickets',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    const ticket = await JiraService.getTicket({ issueKey, includeComments, userId });

    return {
      success: true,
      ticket,
      message: `Retrieved details for ticket ${issueKey}`
    };
  } catch (error) {
    console.error('❌ Error in getTicket:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'GET_TICKET_FAILED',
      message: `Failed to get ticket ${issueKey}: ${error.message}`
    };
  }
}

/**
 * Add a comment to a JIRA ticket
 * @param {Object} params - Comment parameters
 * @param {string} params.issueKey - JIRA issue key (e.g., 'PROJ-123')
 * @param {string} params.comment - Comment text to add
 * @param {boolean} [params.requireConfirmation=true] - Require user confirmation
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Comment addition result
 */
export async function addComment({ issueKey, comment, requireConfirmation = true, user }) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to add comments',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    // Note: In a real implementation, confirmation would be handled by the UI
    // For now, we'll add a warning in the response
    if (requireConfirmation) {
      console.log(`⚠️ Adding comment to ${issueKey} requires user confirmation`);
    }

    const result = await JiraService.addComment({ issueKey, comment, userId });

    return {
      success: true,
      comment: result,
      message: `Comment added to ticket ${issueKey}`,
      requiresConfirmation: requireConfirmation
    };
  } catch (error) {
    console.error('❌ Error in addComment:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'ADD_COMMENT_FAILED',
      message: `Failed to add comment to ${issueKey}: ${error.message}`
    };
  }
}

/**
 * Get available status transitions for a ticket
 * @param {Object} params - Transition parameters
 * @param {string} params.issueKey - JIRA issue key (e.g., 'PROJ-123')
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Available transitions
 */
export async function getTransitions({ issueKey, user }) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to view transitions',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    const result = await JiraService.getTransitions({ issueKey, userId });

    return {
      success: true,
      ...result,
      message: `Found ${result.transitions.length} available transitions for ${issueKey}`
    };
  } catch (error) {
    console.error('❌ Error in getTransitions:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'GET_TRANSITIONS_FAILED',
      message: `Failed to get transitions for ${issueKey}: ${error.message}`
    };
  }
}

/**
 * Change the status of a JIRA ticket
 * @param {Object} params - Transition parameters
 * @param {string} params.issueKey - JIRA issue key (e.g., 'PROJ-123')
 * @param {string} params.transitionId - ID of the transition to perform
 * @param {string} [params.comment] - Optional comment to add with transition
 * @param {boolean} [params.requireConfirmation=true] - Require user confirmation
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Transition result
 */
export async function transitionTicket({
  issueKey,
  transitionId,
  comment,
  requireConfirmation = true,
  user
}) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to transition tickets',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    // Note: In a real implementation, confirmation would be handled by the UI
    // For now, we'll add a warning in the response
    if (requireConfirmation) {
      console.log(`⚠️ Transitioning ${issueKey} requires user confirmation`);
    }

    const result = await JiraService.transitionTicket({ issueKey, transitionId, comment, userId });

    return {
      success: true,
      ...result,
      requiresConfirmation: requireConfirmation
    };
  } catch (error) {
    console.error('❌ Error in transitionTicket:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'TRANSITION_FAILED',
      message: `Failed to transition ${issueKey}: ${error.message}`
    };
  }
}

/**
 * Download and access ticket attachments
 * @param {Object} params - Attachment parameters
 * @param {string} params.attachmentId - JIRA attachment ID
 * @param {boolean} [params.returnBase64=false] - Return attachment content as Base64
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Attachment information and content
 */
export async function getAttachment({ attachmentId, returnBase64 = false, user }) {
  try {
    if (!user?.id) {
      throw new Error('User authentication required for JIRA access');
    }

    const userId = user.id;
    const isAuthenticated = await JiraService.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'Please connect your JIRA account to access attachments',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    const attachment = await JiraService.getAttachment({ attachmentId, returnBase64, userId });

    return {
      success: true,
      attachment,
      message: `Retrieved attachment ${attachment.filename}`
    };
  } catch (error) {
    console.error('❌ Error in getAttachment:', error.message);

    if (error.message.includes('authentication required')) {
      return {
        error: 'JIRA_AUTH_REQUIRED',
        message: 'JIRA authentication expired. Please reconnect your account.',
        authUrl: '/api/integrations/jira/auth'
      };
    }

    return {
      error: 'GET_ATTACHMENT_FAILED',
      message: `Failed to get attachment ${attachmentId}: ${error.message}`
    };
  }
}

// Export default with all methods for tool loader compatibility
export default {
  searchTickets,
  getTicket,
  addComment,
  getTransitions,
  transitionTicket,
  getAttachment
};
