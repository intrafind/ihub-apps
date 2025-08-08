#!/bin/bash

# Kill processes on specified ports
# Usage: ./kill-ports.sh

PORTS=(3000 3001 5173 5174)

echo "Checking for processes on ports: ${PORTS[@]}"

for port in "${PORTS[@]}"; do
    echo "Checking port $port..."
    
    # Find PID using the port
    pid=$(lsof -ti tcp:$port)
    
    if [ -n "$pid" ]; then
        echo "Found process $pid on port $port - killing it..."
        kill -9 $pid
        
        # Verify the process was killed
        if kill -0 $pid 2>/dev/null; then
            echo "Failed to kill process $pid on port $port"
        else
            echo "Successfully killed process on port $port"
        fi
    else
        echo "No process found on port $port"
    fi
done

echo "Port cleanup complete!"