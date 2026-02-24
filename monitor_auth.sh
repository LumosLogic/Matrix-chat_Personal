#!/bin/bash

echo "=== Matrix Homeserver Authentication Monitor ==="
echo "Monitoring for 401 errors and session invalidation issues..."
echo ""

# Follow logs and filter for authentication-related entries
docker logs -f synapse 2>&1 | grep -E "(login|sync|401|Unauthorized|access_token|authentication)" --line-buffered
