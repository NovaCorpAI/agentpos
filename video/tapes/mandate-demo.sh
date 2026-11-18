#!/bin/sh
# Recording wrapper: runs the demo binary that `cargo test --no-run` already built.
bin=$(ls -t /target/debug/build/agentpos-mandate-policy/*/out/mandate_demo-* | grep -v '\.d$' | head -1)
AGENTPOS_DEMO_PAUSE_MS=${AGENTPOS_DEMO_PAUSE_MS:-1700} "$bin" --nocapture -q 2>/dev/null |
  grep --line-buffered -vE '^(running [0-9]+ test|test (result|demo_)|Writing test snapshot|\.$)'
