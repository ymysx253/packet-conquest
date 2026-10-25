#!/bin/sh
# Azure App Service (Linux) start script. Startup command: sh start-azure.sh  (docs/DEPLOY.md)
# Uses the bundled official Node.js in runtime/node (tools/fetch-node-runtime.js) because the built-in "Node 24 LTS" image is old.
# Falls back to the built-in node if the bundled one is missing.
cd "$(dirname "$0")"
if [ -f runtime/node/bin/node ]; then
  chmod +x runtime/node/bin/node
  exec runtime/node/bin/node server/index.js
fi
echo "runtime/node/bin/node is missing; using the built-in node ($(node -v))"
exec node server/index.js
