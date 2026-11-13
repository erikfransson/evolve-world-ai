#!/usr/bin/env bash
# Runs the coverage step. A vitest worker sometimes dies natively on the runner
# (SIGTRAP/SIGSEGV); retry once when that is the only problem, fail at once otherwise.
set -uo pipefail
log="${CI_COVERAGE_LOG:-$(mktemp)}"

npm run coverage 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && exit 0

plain="$(sed 's/\x1b\[[0-9;]*m//g' "$log")"
crashed() { grep -q 'Worker exited unexpectedly with signal' <<<"$plain"; }
failed() { grep -Eq '(Test Files|Tests) +[0-9]+ failed| FAIL ' <<<"$plain"; }

if crashed && ! failed; then
  echo "::warning::A test worker crashed natively (not a test failure); retrying the coverage step once."
  exec npm run coverage
fi
exit "$code"
