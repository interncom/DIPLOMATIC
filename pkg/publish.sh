#!/usr/bin/env bash
# Publish @interncom/diplomatic: clean, build, check.mjs, npm publish.
# npm login / npm publish may print a URL — open it on a device with 2FA.
set -euo pipefail
cd "$(dirname "$0")"

bun install
bun run clean
bun run build
bun check.mjs

if user=$(npm whoami 2>/dev/null); then
  echo "npm user: ${user}"
else
  echo "npm session missing or expired. npm login will print a URL — open it with 2FA."
  npm login
fi

echo "npm publish may print a 2FA URL — open it to authorize."
npm publish
