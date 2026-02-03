#!/bin/bash
#
# Demonstration of structured logging with component names
# This script shows how to query and filter logs using jq
#

echo "=== Structured Logging Demonstration ==="
echo ""

# Create a temporary log file with sample structured logs
TEMP_LOG=$(mktemp)

# Generate sample logs
cat > "$TEMP_LOG" << 'EOF'
{"component":"Server","level":"info","message":"Running in normal mode","timestamp":"2026-02-03T12:28:58.382Z"}
{"component":"Server","level":"info","message":"Server is running","protocol":"http","host":"0.0.0.0","port":3000,"url":"http://0.0.0.0:3000","timestamp":"2026-02-03T12:29:01.123Z"}
{"component":"ChatService","level":"info","message":"Chat request received","type":"CHAT_REQUEST","id":"msg-1770117575710-703","appId":"platform","modelId":"gpt-oss-vllm","sessionId":"chat-98bc4fb4-3545","user":"john.doe","query":"How do I create a user account?","timestamp":"2026-02-03T12:29:05.456Z"}
{"component":"ChatService","level":"info","message":"Chat request received","type":"CHAT_REQUEST","id":"msg-1770117575710-704","appId":"summarizer","modelId":"gpt-4","sessionId":"chat-12345678-abcd","user":"jane.smith","query":"Summarize this document","timestamp":"2026-02-03T12:29:10.789Z"}
{"component":"ChatService","level":"info","message":"Chat response generated","type":"CHAT_RESPONSE","id":"msg-1770117575710-703","appId":"platform","modelId":"gpt-oss-vllm","sessionId":"chat-98bc4fb4-3545","user":"john.doe","timestamp":"2026-02-03T12:29:08.234Z"}
{"component":"AuthService","level":"warn","message":"API key missing for provider","provider":"openai","timestamp":"2026-02-03T12:29:02.567Z"}
{"component":"Server","level":"error","message":"Failed to initialize configuration","error":"File not found","stack":"Error: File not found\n    at ...","timestamp":"2026-02-03T12:29:03.890Z"}
{"component":"ChatService","level":"info","message":"User feedback received","type":"FEEDBACK","id":"msg-1770117575710-703","appId":"platform","modelId":"gpt-oss-vllm","sessionId":"chat-98bc4fb4-3545","user":"john.doe","rating":5,"timestamp":"2026-02-03T12:29:15.123Z"}
EOF

echo "Sample logs created at: $TEMP_LOG"
echo ""

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "⚠️  jq is not installed. Install it with: sudo apt-get install jq"
    echo ""
    echo "Showing raw logs instead:"
    cat "$TEMP_LOG"
    rm "$TEMP_LOG"
    exit 0
fi

echo "1. Filter by component (ChatService):"
echo "   Command: cat logs/app.log | jq 'select(.component == \"ChatService\")'"
echo ""
cat "$TEMP_LOG" | jq 'select(.component == "ChatService")'
echo ""

echo "2. Filter by log type (CHAT_REQUEST):"
echo "   Command: cat logs/app.log | jq 'select(.type == \"CHAT_REQUEST\")'"
echo ""
cat "$TEMP_LOG" | jq 'select(.type == "CHAT_REQUEST")'
echo ""

echo "3. Filter by level (error):"
echo "   Command: cat logs/app.log | jq 'select(.level == \"error\")'"
echo ""
cat "$TEMP_LOG" | jq 'select(.level == "error")'
echo ""

echo "4. Extract specific fields:"
echo "   Command: cat logs/app.log | jq '{timestamp, component, message, user}'"
echo ""
cat "$TEMP_LOG" | jq '{timestamp, component, message, user}' | head -20
echo ""

echo "5. Count requests by app:"
echo "   Command: cat logs/app.log | jq 'select(.type == \"CHAT_REQUEST\") | .appId' | sort | uniq -c"
echo ""
cat "$TEMP_LOG" | jq -r 'select(.type == "CHAT_REQUEST") | .appId' | sort | uniq -c
echo ""

echo "6. Get all logs for a specific session:"
echo "   Command: cat logs/app.log | jq 'select(.sessionId == \"chat-98bc4fb4-3545\")'"
echo ""
cat "$TEMP_LOG" | jq 'select(.sessionId == "chat-98bc4fb4-3545")'
echo ""

echo "7. Filter by component and level:"
echo "   Command: cat logs/app.log | jq 'select(.component == \"Server\" and .level == \"error\")'"
echo ""
cat "$TEMP_LOG" | jq 'select(.component == "Server" and .level == "error")'
echo ""

echo "8. Most active components:"
echo "   Command: cat logs/app.log | jq -r '.component' | sort | uniq -c | sort -rn"
echo ""
cat "$TEMP_LOG" | jq -r '.component' | sort | uniq -c | sort -rn
echo ""

echo "=== Demonstration Complete ==="
echo ""
echo "For more information, see: docs/logging.md"
echo ""

# Clean up
rm "$TEMP_LOG"
