#!/bin/sh
# Azure App Service (Linux) start script. Startup command: sh start-azure.sh  (docs/DEPLOY.md)
# Uses the bundled official Node.js in runtime/node (tools/fetch-node-runtime.js) because the built-in "Node 24 LTS" image is old.
# Falls back to the built-in node if the bundled one is missing.
# The binary is copied to /tmp (local disk) and run from there: /home is a network share, and a running file there
# cannot be replaced, so the next deploy failed with "rsync: rename ... runtime/node/bin/node: No such file or directory" (2026-10-26).
cd "$(dirname "$0")"
if [ -f runtime/node/bin/node ]; then
  RUN=/tmp/pc-node-$$
  if cp runtime/node/bin/node "$RUN" 2>/dev/null && chmod +x "$RUN"; then
    exec "$RUN" server/index.js
  fi
  echo "could not copy runtime/node/bin/node to /tmp; running it in place"
  chmod +x runtime/node/bin/node
  exec runtime/node/bin/node server/index.js
fi
echo "runtime/node/bin/node is missing; using the built-in node ($(node -v))"
exec node server/index.js
