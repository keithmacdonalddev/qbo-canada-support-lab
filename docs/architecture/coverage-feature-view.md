# Actual coverage results and supporting requirements

Coverage defaults to results for the connected company. Static requirements and
record-presence lists remain secondary. See [research](../design/coverage-research.md).

## Feature representation

The canonical discovery catalog supplies all business areas and named variants.
The three app-operating requirements remain outside the company-data denominator.
Every business variant receives a result; unmapped variants are visibly unverified.
The explicit semantic mappings in coverage-results.mjs compare existing scoped scan
observations with those named variants. They do not turn arbitrary payments into full
settlement, overdue invoices into paid-late invoices, or generic foreign activity into
USD customer/vendor evidence. Positive narrow predicates do not prove broad absence.
One qualifying asset or liability establishes its category even when the older scan
volume threshold was two. A missing result requires a complete qualifying observation.

The summary counts represented, missing and unverified **business situations**, not
successful internal checks. This is observed functionality, not certification of every
linked lifecycle, realistic amount or report. Required periods and report evidence
remain separate. Rows expose the exact represented and unresolved names and their
qualifying observation counts/dates, with links to source data and full requirements.

Coverage alone opts into useCoverage's cached-only initial read and accepts older
snapshots with their original timestamp. It does not replace useful prior results
with a long automatic scan. The explicit Read company data / Refresh record evidence
action retains the existing read workflow. Other useCoverage callers keep the existing
automatic-scan default. Connection changes invalidate in-flight feature reads.

## Report outcomes

The result workspace reads existing manual report-history GETs with four concurrent
workers and saved baseline-list/detail GETs with at most two detail readers. No new
report capture or save is triggered. Responses must match realm, environment and
connection, with actor/scope remounting and cancellation. Read failures never establish
missing evidence. Earlier manual/history pages remain labelled unsearched.

A complete owner-recorded result requires all four evidence levels and assertions to
pass for the current matching definition; its exact period, basis and filters remain
visible. The latest decision per identical scope is used; different scopes remain
separate. Withdrawn observations do not count. Saved native report availability is
partial proof. Relevant failed balance/aging relationships produce differences for
their related reports only. Returned basis and report evidence type are preserved;
a common requested Accrual scope never invents a basis absent from an aging statement.

The page inspects one bounded manual page per report and ten stored observations.
Unsearched history and failed source reads remain explicit. A verified recorded scope
is not an assertion that every catalog period or full historical report coverage passes.

## Historical coverage

The published starting date and managed calendar cursor establish completed managed
months. An opening baseline contributes zero completed months. The target length is
read from the current saved draft only when its content hash matches the published
blueprint. Otherwise the target is unavailable. Unmanaged old records, app protection
and bank reconciliation are not conflated with managed business-period verification.

## Supporting workflows and boundaries

Feature/report requirements retain the catalog's prerequisites, conditional scope,
variations, source-dated applicability and API/manual classifications. Company data
retains local filters, manual instructions, source failures, Explorer links and the
existing eligible support-case action. No new mutation, execution, auth, or approval
route is introduced. No services or company records are changed by this implementation.

Focused non-live tests cover target accounting, semantic mapping boundaries, partial
and failed evidence, exact scope/definition checks, month completion, bounded report
concurrency and cancellation, alongside the prior feature/target tests.
