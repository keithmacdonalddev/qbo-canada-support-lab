#!/usr/bin/env bash
# Fails if the staged diff adds something that looks like a real credential. Prints file names only.
cd "$(git rev-parse --show-toplevel)"
hits=$(git diff --cached -U0 | grep -E '^\+' | grep -v '^+++' | grep -nE '(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|Bearer [A-Za-z0-9._-]{30,}|"refresh_token"\s*:\s*"[^"]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)' || true)
files=$(git diff --cached --name-only | grep -E '(^|/)\.env|\.tokens\.json$' || true)
if [ -n "$hits$files" ]; then echo "Possible secret in staged changes (values not shown)."; [ -n "$files" ] && echo "$files"; exit 1; fi
echo "staged diff: no secret patterns"
