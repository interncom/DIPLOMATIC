#!/bin/bash

set -e  # Exit on any error

paths=(
  shared/
  deno/src/
  deno/tests/
  web/src/
  web/perf/
  hosts/cloudflare/src/
)

echo "Running deno fmt on ${paths[*]}..."
deno fmt "${paths[@]}"

echo "Running deno lint on ${paths[*]}..."
deno lint "${paths[@]}"

echo "All style checks passed!"
