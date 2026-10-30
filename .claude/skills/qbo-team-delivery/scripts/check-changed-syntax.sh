#!/usr/bin/env bash
# node --check every changed or new backend .js file; the live backend reloads on save.
cd "$(git rev-parse --show-toplevel)"
bad=0
for f in $(git status --porcelain | awk '{print $NF}' | grep '^backend/.*\.js$'); do
  node --check "$f" 2>/dev/null || { echo "SYNTAX ERROR: $f"; bad=1; }
done
[ $bad = 0 ] && echo "changed backend files parse"; exit $bad
