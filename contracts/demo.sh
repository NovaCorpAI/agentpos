#!/usr/bin/env sh
# Prints the mandate demo: one story, step by step, against the contracts.
#
#   ./demo.sh            run it natively
#   ./demo.sh --wasm     run it against the built WASM (needs `stellar contract build` first)
#
# AGENTPOS_DEMO_PAUSE_MS=1200 ./demo.sh   pauses between steps, for a recording.
set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = "--wasm" ]; then
  AGENTPOS_WASM_DIR="$PWD/target/wasm32v1-none/release"
  export AGENTPOS_WASM_DIR
fi

cargo test -q -p agentpos-mandate-policy --test mandate_demo --no-run 2>/dev/null
cargo test -q -p agentpos-mandate-policy --test mandate_demo -- --nocapture 2>/dev/null |
  grep --line-buffered -vE '^(running [0-9]+ test|test (result|demo_)|Writing test snapshot|\.$)'
