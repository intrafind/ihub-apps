import authDebugService from '../../utils/authDebugService.js';

/**
 * Authentication Debug API Routes
 * Provides admin endpoints for managing authentication debug logs
 */
export default function registerAuthDebugRoutes(app) {
  /**
   * Get authentication debug logs with filtering and pagination
   * GET /api/admin/auth/debug/logs
   */
  app.get('/api/admin/auth/debug/logs', async (req, res) => {
    try {
      const {
        provider,
        level,
        sessionId,
        limit = '50',
        offset = '0',
        startTime,
        endTime
      } = req.query;

      const options = {
        provider: provider || null,
        level: level || null,
        sessionId: sessionId || null,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        startTime: startTime || null,
        endTime: endTime || null
      };

      const result = authDebugService.getDebugLogs(options);

      res.json({
        ...result,
        debugEnabled: authDebugService.isDebugEnabled(),
        config: authDebugService.getDebugConfig()
      });
    } catch (error) {
      console.error('Error getting auth debug logs:', error);
      res.status(500).json({
        error: 'Failed to get debug logs',
        details: error.message
      });
    }
  });

  /**
   * Get logs for a specific session
   * GET /api/admin/auth/debug/sessions/:sessionId/logs
   */
  app.get('/api/admin/auth/debug/sessions/:sessionId/logs', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { limit = '50' } = req.query;

      const logs = authDebugService.getSessionLogs(sessionId, parseInt(limit, 10));

      res.json({
        sessionId,
        logs,
        total: logs.length
      });
    } catch (error) {
      console.error('Error getting session debug logs:', error);
      res.status(500).json({
        error: 'Failed to get session logs',
        details: error.message
      });
    }
  });

  /**
   * Get debug statistics and summary
   * GET /api/admin/auth/debug/stats
   */
  app.get('/api/admin/auth/debug/stats', async (req, res) => {
    try {
      const stats = authDebugService.getDebugStats();

      res.json({
        ...stats,
        debugEnabled: authDebugService.isDebugEnabled(),
        config: authDebugService.getDebugConfig()
      });
    } catch (error) {
      console.error('Error getting auth debug stats:', error);
      res.status(500).json({
        error: 'Failed to get debug statistics',
        details: error.message
      });
    }
  });

  /**
   * Clear authentication debug logs
   * DELETE /api/admin/auth/debug/logs
   */
  app.delete('/api/admin/auth/debug/logs', async (req, res) => {
    try {
      const { provider } = req.query;

      authDebugService.clearLogs(provider || null);

      res.json({
        message: provider
          ? `Debug logs cleared for provider: ${provider}`
          : 'All debug logs cleared successfully'
      });
    } catch (error) {
      console.error('Error clearing auth debug logs:', error);
      res.status(500).json({
        error: 'Failed to clear debug logs',
        details: error.message
      });
    }
  });

  /**
   * Export debug logs in various formats
   * GET /api/admin/auth/debug/export
   */
  app.get('/api/admin/auth/debug/export', async (req, res) => {
    try {
      const {
        format = 'json',
        provider,
        level,
        sessionId,
        startTime,
        endTime,
        limit = '1000'
      } = req.query;

      const options = {
        provider: provider || null,
        level: level || null,
        sessionId: sessionId || null,
        limit: parseInt(limit, 10),
        startTime: startTime || null,
        endTime: endTime || null
      };

      const exportData = authDebugService.exportLogs(format, options);

      // Set appropriate headers based on format
      let contentType;
      let filename;

      switch (format) {
        case 'csv':
          contentType = 'text/csv';
          filename = `auth-debug-logs-${new Date().toISOString().split('T')[0]}.csv`;
          break;
        case 'text':
          contentType = 'text/plain';
          filename = `auth-debug-logs-${new Date().toISOString().split('T')[0]}.txt`;
          break;
        default:
          contentType = 'application/json';
          filename = `auth-debug-logs-${new Date().toISOString().split('T')[0]}.json`;
      }

      res.set({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`
      });

      res.send(exportData);
    } catch (error) {
      console.error('Error exporting auth debug logs:', error);
      res.status(500).json({
        error: 'Failed to export debug logs',
        details: error.message
      });
    }
  });

  /**
   * Test authentication provider debug logging
   * POST /api/admin/auth/debug/test/:provider
   */
  app.post('/api/admin/auth/debug/test/:provider', async (req, res) => {
    try {
      const { provider } = req.params;
      const { testType = 'config' } = req.body;

      // Create a test debug log entry
      const logId = authDebugService.log(
        provider,
        'info',
        'manual_test',
        {
          testType,
          triggeredBy: 'admin_api',
          timestamp: new Date().toISOString(),
          message: `Manual test of ${provider} provider debug logging`,
          adminUser: req.user?.id || 'unknown'
        },
        {
          sessionId: req.sessionID || 'test-session',
          userId: req.user?.id,
          requestId: req.id,
          userAgent: req.headers['user-agent'],
          ip: req.ip
        }
      );

      res.json({
        message: `Test debug log created for ${provider} provider`,
        testType,
        logId,
        debugEnabled: authDebugService.isDebugEnabled(provider)
      });
    } catch (error) {
      console.error('Error testing auth provider debug:', error);
      res.status(500).json({
        error: 'Failed to test provider debug logging',
        details: error.message
      });
    }
  });

  /**
   * Get real-time debug logs (Server-Sent Events)
   * GET /api/admin/auth/debug/stream
   */
  app.get('/api/admin/auth/debug/stream', (req, res) => {
    // Set headers for Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial connection message
    res.write('data: {"type":"connected","message":"Debug log stream connected"}\n\n');

    // Listen for debug events
    const onDebugLog = logEntry => {
      const { provider } = req.query;

      // Filter by provider if specified
      if (provider && logEntry.provider !== provider) {
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          type: 'log',
          data: logEntry
        })}\n\n`
      );
    };

    const onDebugCleared = data => {
      res.write(
        `data: ${JSON.stringify({
          type: 'cleared',
          data
        })}\n\n`
      );
    };

    // Register event listeners
    authDebugService.on('authDebugLog', onDebugLog);
    authDebugService.on('authDebugCleared', onDebugCleared);

    // Cleanup on client disconnect
    req.on('close', () => {
      authDebugService.off('authDebugLog', onDebugLog);
      authDebugService.off('authDebugCleared', onDebugCleared);
    });

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write('data: {"type":"ping"}\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
    });
  });
}
