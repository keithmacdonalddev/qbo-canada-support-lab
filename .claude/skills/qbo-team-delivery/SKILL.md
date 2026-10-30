---
name: qbo-team-delivery
description: Multi-agent delivery workflow for building a new accountant workflow or other multi-file backend/UI feature in the Test Data Lab repo (C:/Projects/qbo). Claude Opus implements, GPT-6.1 Sol reviews the plan and the code read-only through the Codex companion, the qbo-safety-reviewer checks QuickBooks write paths, and gpt-6-luna runs every test. Use when the owner asks to build or extend accountant tools, same-day activity workflows, or another feature that needs a plan, implementation, independent review, tests and a commit. Do NOT use for questions, status reports, single-file fixes, documentation-only edits, or reviews the owner asked for without implementation.
---

# QBO Team Delivery

Builds a feature through plan → Sol plan review → Opus implementation → Sol and safety review → Luna tests → commit, with a short owner brief at each checkpoint. Shared repo rules (branch, secrets, services, QBO safety) live in `AGENTS.md` and `.claude/rules/` and are not repeated here. Roles, tool limits and pitfalls are in [references/roles-and-limits.md](references/roles-and-limits.md).

## Workflow

First tell the owner in one line that the qbo-team-delivery workflow is being used and for what. Repeat that line in each brief.

Copy this checklist into the task and tick items as they finish:

```
- [ ] 0. Preflight passes
- [ ] 1. Plan written
- [ ] 2. Sol plan review fetched (watcher armed when started)
- [ ] 3. Findings verified against code; owner briefed
- [ ] 4. Opus implementation committed or ready
- [ ] 5. Sol code review + safety review done; fixes verified (≤3 rounds); owner briefed
- [ ] 6. Luna tests pass (all affected files; frontend lint/build if UI changed)
- [ ] 7. UI checked in a browser (visible changes only)
- [ ] 8. Committed and pushed (own hunks only, secret scan clean)
- [ ] 9. Live result confirmed read-only when the capability first runs
- [ ] 10. Final owner brief
```

0. **Preflight.** Run `bash .claude/skills/qbo-team-delivery/scripts/preflight.sh`. If something is missing, use the fallback below and tell the owner which fallback is in use.
1. **Plan.** Write goal, files, invariants and tests to `artifacts/luna/tmp/<topic>-plan.txt` (gitignored). Update the matching `docs/plans/*.md`.
2. **Sol plan review.** Run `bash .claude/skills/qbo-team-delivery/scripts/codex.sh task --background --model gpt-6.1-sol --effort xhigh "$(cat artifacts/luna/tmp/<topic>-plan.txt)"`. In the same response, start a `Monitor` running `bash .claude/skills/qbo-team-delivery/scripts/codex-watch.sh <job-id>`. Codex jobs never notify Claude on their own. When it ends, run `codex.sh result <job-id> > artifacts/luna/tmp/<topic>-review.md`.
3. **Verify, then brief.** Open the cited file:line for each top finding before accepting it. Brief the owner: findings, accepted or rejected with reason, what changes. A review is never passed on as a spec unverified.
4. **Implement.** Start one background **fresh** subagent (`subagent_type: worker` or `general-purpose`, `model: opus`) with a self-contained brief: goal, spec path, files to read first, rules and the report wanted. Do not use `fork`: a fork inherits the whole conversation and burns hundreds of thousands of tokens of context on every step. Tell it:
   - every saved file must stay syntactically valid, because the backend reloads live;
   - tests run only through Luna;
   - commit only its own files.
   Never run two implementers on the same files.
5. **Code reviews.** Run read-only, in parallel:
   - Sol on the commit or diff (as in step 2, no `--write`);
   - `qbo-safety-reviewer` when QuickBooks writes or operation state change.
   Verify the findings and fix the confirmed ones. Send fixes larger than a few lines, or on a write path, back to Sol. Stop after 3 rounds and report what remains to the owner. Record deferred findings in the plan doc.
6. **Tests.** Follow the Luna rules in the reference file. Broad changes run every `backend/test/business-*.test.js`, plus frontend lint and build when UI changed.
7. **UI check.** For visible changes, screenshot the page in a named `agent-browser` session at desktop width, inspect it, then close the session.
8. **Commit.** Run `bash .claude/skills/qbo-team-delivery/scripts/check-changed-syntax.sh`, stage only owned paths or hunks, run `bash .claude/skills/qbo-team-delivery/scripts/staged-secret-scan.sh`, then commit and push to `origin/main`.
9. **Live check.** When the accountant first uses the capability, confirm in QuickBooks, read-only, what it saved.
10. **Final brief.** Commit, proof (tests, reviews, live evidence), limits, and any owner action.

## Fallbacks

- **Sol unavailable** (companion missing, plan limit reached, job fails twice): run the plan and code reviews with a fresh read-only Claude reviewer (`implementation-reviewer` or `harness-reviewer`, `model: opus`) given the same brief. Label it to the owner as a same-vendor review, which is less independent than Sol.
- **Luna unavailable** (the bridge fails 3 times with nothing run): the project contract (`AGENTS.md`, `docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md`) says to report the checks as blocked and not substitute another model. Do not commit a write-path change on unrun tests. Report what is blocked and keep other work moving.
- **agent-browser unavailable:** skip the screenshot, say the UI is unverified, and keep the change uncommitted if it is a material visual change.

## Reference

- [references/roles-and-limits.md](references/roles-and-limits.md): who does what, Luna bridge limits, the Codex companion, accountant policy conventions, pitfalls.
- [evals/scenarios.md](evals/scenarios.md): trigger and behaviour scenarios for checking this skill.
- Model choices: `docs/agent-harness/MODEL_SELECTION.md`. Test execution contract: `docs/agent-harness/DETERMINISTIC_TEST_EXECUTION.md`.
