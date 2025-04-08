#!/bin/bash
# Start both server and client with better error handling

# Function to clean up processes when the script exits
function cleanup {
  echo "Shutting down processes..."
  
  # Kill the server if it's running
  if [ ! -z "$SERVER_PID" ]; then
    kill $SERVER_PID 2>/dev/null || true
  fi
  
  # Kill any other node processes started by this script if needed
  # pkill -P $$ node 2>/dev/null || true
  
  echo "Cleanup complete!"
  exit
}

# Set up trap to catch script termination
trap cleanup EXIT INT TERM

# Start the server
echo "Starting server..."
cd server && node server.js &
SERVER_PID=$!

# Wait a moment for the server to start
sleep 2

# Check if server started successfully
if ! ps -p $SERVER_PID > /dev/null; then
  echo "Server failed to start. Check for errors above."
  exit 1
fi

# Start the client
echo "Starting client..."
cd client && npm run dev

# The cleanup function will be called automatically when the script exits 