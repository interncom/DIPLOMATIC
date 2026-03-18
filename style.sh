#!/bin/bash

set -e  # Exit on any error

echo "Running deno fmt on shared/, deno/src/, and web/src/..."
deno fmt shared/ deno/src/ deno/tests/ web/src/ hosts/cloudflare/src/ demos/count/web/src/

echo "Running deno lint on shared/, deno/src/, and web/src/..."
deno lint shared/ deno/src/ deno/tests/ web/src/ hosts/cloudflare/src/ demos/count/web/src/

echo "All style checks passed!"
