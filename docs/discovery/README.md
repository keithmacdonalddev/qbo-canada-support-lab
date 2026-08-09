# Capability and report discovery

This folder starts rebuild Phase 1. It is a static research and review surface; it does not call QBO, connect OAuth, read the Production company, or write MongoDB.

## Files

- `registry.schema.v1.json` — versioned JSON Schema for capabilities, reports, evidence, sources, and release-state rules.
- `catalog.v1.json` — machine-readable starter catalog. It is intentionally in `discovery` status.
- `catalog.v1.md` — plain-English review of the starter catalog, confirmed official facts, conflicts, and next decisions.

Run the local structural checks with:

```powershell
npm run validate:discovery
```

The current validator checks JSON parsing, required fields, unique keys, source/report references, supported-report endpoints, evidence dates, and the rule that an approved catalog cannot contain release-blocking unknowns. It is not a full JSON Schema engine; adopting one is a later dependency decision.

## How to read the catalog

Five different questions are kept separate:

1. **Product applicability:** Is the feature available in QBO Advanced Canada and enabled in the connected company?
2. **API operations:** Can the current documented API read, create, update, delete, or void it?
3. **Current app status:** Does the existing Test Data Lab source implement any of it?
4. **Dataset coverage:** Does the flagship company contain representative, realistic evidence?
5. **Evidence status:** What current source, fixture, sandbox result, Production canary, or manual review supports the claim?

`documented` means an official source supports the specific facts recorded in that row. It does not mean the capability is covered. `unknown` is correct during discovery and blocks release.

## Updating the catalog

1. Keep stable keys. Create a new catalog/schema version for breaking meaning changes.
2. Cite current official Intuit sources for product/API facts.
3. Record Canada/Advanced applicability separately from API availability.
4. Do not mark a write operation supported from a general platform overview; review its exact current entity/GraphQL reference.
5. Do not mark coverage from source code or an HTTP success. Record realistic data, report, accounting, and reviewer evidence.
6. For UI-only or unsupported automation, use `manual-only` with an evidence procedure rather than a fabricated API path.
7. Any read benchmark or sandbox write needs the approval record required by `REBUILD_RELEASE_EVIDENCE.md`.
8. Production remains outside Phase 1 discovery mutations.

## Phase 1 passing boundary

The catalog cannot move to `approved` until:

- every candidate Tier 1 capability has no release-blocking unknown;
- every critical report has exact product/API/manual status, prerequisites, assertions, and evidence method;
- current-app entitlements are distinguished from QBO product entitlement;
- users/roles, Canadian tax, budgets, reconciliation, projects, pagination, and rate/batch limits are resolved honestly;
- approved exclusions have an owner and rationale;
- any live observation has a recorded target, budget, result, and reviewer decision.
