// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// JIRA Integration Tool
// Provides comprehensive JIRA ticket management capabilities

import JiraService from '../services/integrations/JiraService.js';
import logger from '../utils/logger.js';
import { JIRA_INSTANCE_ID } from '../services/integrations/jiraConfig.js';
import { getIntegrationConnectionService } from '../services/integrations/auth/IntegrationConnectionService.js';
import {
  INTEGRATION_AUTH_REASONS,
  integrationAuthRequiredResult,
  isIntegrationAuthRequired
} from '../services/integrations/auth/integrationAuthRequired.js';

/**
 * The structured "connect first" result when the caller has no usable Jira
 * connection, or null when they do. Resolves the caller's **own** connection
 * (in a scheduled run: the task owner's), never anybody else's.
 *
 * @param {Object} user - The caller (params.user)
 * @param {string} message - What to tell the user when they never connected
 * @returns {Promise<Object|null>}
 */
async function jiraConnectionMissing(user, message) {
  const principal = { type: 'user', id: user?.id ? String(user.id) : '' };
  const resolved =
    user?.id && user.id !== 'anonymous'
      ? await getIntegrationConnectionService().resolve(principal, JIRA_INSTANCE_ID)
      : { ok: false, error: { reason: INTEGRATION_AUTH_REASONS.NOT_CONNECTED } };
  if (resolved.ok) return null;
  const reason = resolved.error?.reason || INTEGRATION_AUTH_REASONS.NOT_CONNECTED;
  return integrationAuthRequiredResult({
    integration: JIRA_INSTANCE_ID,
    reason,
    message:
      reason === INTEGRATION_AUTH_REASONS.NOT_CONNECTED
        ? message
        : 'JIRA authentication expired. Please reconnect your account.'
  });
}

/**
 * The "connect first" result for an error a Jira call threw because the
 * connection could not be used (refresh token refused, revoked), or null.
 * @param {Error} error
 * @returns {Object|null}
 */
function jiraAuthFailure(error) {
  if (
    !isIntegrationAuthRequired(error) &&
    !/authentication (required|expired)/i.test(error?.message || '')
  ) {
    return null;
  }
  return integrationAuthRequiredResult({
    integration: JIRA_INSTANCE_ID,
    reason: error.reason || INTEGRATION_AUTH_REASONS.EXPIRED,
    message: 'JIRA authentication expired. Please reconnect your account.'
  });
}

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
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to search tickets'
    );
    if (missing) return missing;
    const userId = user.id;

    const results = await JiraService.searchTickets({ jql, maxResults, userId });

    return {
      success: true,
      ...results,
      message: `Found ${results.total} tickets matching your query`
    };
  } catch (error) {
    logger.error('Error in searchTickets', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to view tickets'
    );
    if (missing) return missing;
    const userId = user.id;

    const ticket = await JiraService.getTicket({ issueKey, includeComments, userId });

    return {
      success: true,
      ticket,
      message: `Retrieved details for ticket ${issueKey}`
    };
  } catch (error) {
    logger.error('Error in getTicket', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to add comments'
    );
    if (missing) return missing;
    const userId = user.id;

    // Note: In a real implementation, confirmation would be handled by the UI
    // For now, we'll add a warning in the response
    if (requireConfirmation) {
      logger.info('Adding comment requires user confirmation', {
        component: 'JiraTool',
        issueKey
      });
    }

    const result = await JiraService.addComment({ issueKey, comment, userId });

    return {
      success: true,
      comment: result,
      message: `Comment added to ticket ${issueKey}`,
      requiresConfirmation: requireConfirmation
    };
  } catch (error) {
    logger.error('Error in addComment', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to view transitions'
    );
    if (missing) return missing;
    const userId = user.id;

    const result = await JiraService.getTransitions({ issueKey, userId });

    return {
      success: true,
      ...result,
      message: `Found ${result.transitions.length} available transitions for ${issueKey}`
    };
  } catch (error) {
    logger.error('Error in getTransitions', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
 * @param {string} params.transitionId - ID or name of the transition to perform
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
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to transition tickets'
    );
    if (missing) return missing;
    const userId = user.id;

    // Note: In a real implementation, confirmation would be handled by the UI
    // For now, we'll add a warning in the response
    if (requireConfirmation) {
      logger.info('Transitioning issue requires user confirmation', {
        component: 'JiraTool',
        issueKey
      });
    }

    // If transitionId is not a number, try to find the transition by name
    let actualTransitionId = transitionId;
    if (Number.isNaN(Number.parseInt(transitionId))) {
      const transitions = await JiraService.getTransitions({ issueKey, userId });
      const matchingTransition = transitions.transitions.find(
        t =>
          t.name.toLowerCase() === transitionId.toLowerCase() ||
          t.to.name.toLowerCase() === transitionId.toLowerCase()
      );

      if (matchingTransition) {
        actualTransitionId = matchingTransition.id;
        logger.info('Resolved transition to ID', {
          component: 'JiraTool',
          transitionId,
          actualTransitionId
        });
      } else {
        return {
          error: 'INVALID_TRANSITION',
          message: `Transition "${transitionId}" not found for ticket ${issueKey}. Available transitions: ${transitions.transitions.map(t => t.name).join(', ')}`
        };
      }
    }

    const result = await JiraService.transitionTicket({
      issueKey,
      transitionId: actualTransitionId,
      comment,
      userId
    });

    return {
      success: true,
      ...result,
      requiresConfirmation: requireConfirmation
    };
  } catch (error) {
    logger.error('Error in transitionTicket', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
 * @param {boolean} [params.returnBase64=false] - Return attachment content as Base64 for LLM image analysis
 * @param {Object} params.user - User object from authentication context
 * @returns {Object} Attachment information with passthrough URL or base64 for analysis
 */
export async function getAttachment({ attachmentId, returnBase64 = false, user }) {
  try {
    const missing = await jiraConnectionMissing(
      user,
      'Please connect your JIRA account to access attachments'
    );
    if (missing) return missing;
    const userId = user.id;

    // Get attachment with base64 if requested (for image analysis)
    const attachment = await JiraService.getAttachment({
      attachmentId,
      returnBase64: returnBase64,
      userId
    });

    // Create a passthrough URL that the frontend can use directly
    const passthroughUrl = `/api/integrations/jira/attachment/${attachmentId}`;

    // If base64 is requested and it's an image, prepare for LLM vision analysis
    if (returnBase64 && attachment.mimeType?.startsWith('image/')) {
      return {
        success: true,
        attachment: {
          ...attachment,
          // Include base64 for LLM vision analysis
          imageData: {
            type: 'image',
            format: attachment.mimeType,
            base64: attachment.content,
            filename: attachment.filename
          },
          // Also include passthrough for frontend display
          passthrough: {
            type: 'image',
            url: passthroughUrl,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            attachmentId: attachmentId
          }
        },
        message: `Retrieved image ${attachment.filename} for analysis.`
      };
    }

    // For non-analysis cases or non-images, use passthrough only
    return {
      success: true,
      attachment: {
        ...attachment,
        // Add passthrough information for frontend handling
        passthrough: {
          type: attachment.mimeType?.startsWith('image/') ? 'image' : 'file',
          url: passthroughUrl,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          attachmentId: attachmentId
        }
      },
      message: `Retrieved attachment ${attachment.filename}. ${
        attachment.mimeType?.startsWith('image/')
          ? 'The image can be displayed inline.'
          : 'The file can be downloaded.'
      }`
    };
  } catch (error) {
    logger.error('Error in getAttachment', { component: 'JiraTool', error });

    const authFailure = jiraAuthFailure(error);
    if (authFailure) return authFailure;

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
