# Coverage: problem research and interaction design

Date: 2026-10-20. Scope: the actual Test Data Lab Coverage page.

## Operator problem

The operator needs to understand the business and QuickBooks functionality the
lab is intended to support, compare retained company evidence against that
scope, and identify what remains unrepresented, unverified, manual or unscoped.
The previous page presented record-presence results without a visible target.
Renaming those results or exposing their counts cannot answer this question.

This is requirements-to-evidence navigation. It is not a transaction browser,
an overall readiness score, or a claim that every QuickBooks feature is covered.

## Project evidence

- `prd.md` sections 3 and 6 define the approved business, capability/report
  registry, coherent history, governed calendar, reconciliation and evidence.
- `continual-test-data-lab-rebuild-plan.md` sections 6.3–6.4 distinguish
  representative feature variants and meaningful reports from mere presence.
- Sections 9.1 and 9.3 define service/projects, wholesale/inventory and recurring
  services, with an initial 36-month planning horizon followed by ongoing work.
  This is a design target, not proof of the saved or completed company period.
- `docs/discovery/catalog.v1.json` is the canonical catalog of 24 capability
  areas (21 business areas and 3 app operating requirements) and 48 report definitions. It records prerequisites, variations,
  priorities, report periods and assertions. Definition dates and historical
  implementation notes are not current company evidence.
- `/api/coverage` measures selected setup conditions and bounded transaction
  presence. It does not verify every target variant, three years of history,
  full linked lifecycles or reconciled reports.
- Existing GETs for `company/business-plan` and `company/business-governance`
  read saved application state. The latter exposes publication and the managed
  calendar's verified-through date. No setup, preview, publication or execution
  POST is needed to show that state.
- Existing Reports already provides per-report requirements and retained manual
  evidence. Coverage should deep-link to it instead of recreating its controls
  or declaring its evidence absent without reading it.

## External research and implications

1. [Intuit: Advanced Canada](https://quickbooks.intuit.com/ca/online/advanced/)
   describes Advanced breadth including custom reporting, custom access,
   dimensions, batch entry, Excel integration, automation, revenue recognition
   and backup/restore. These are product features, not evidence that this lab
   has exercised them. Six of these have no explicit capability classification
   in the current catalog. Show the mapping gap; do not silently add or exclude
   them from the approved target.
2. [Intuit: reports included in Canadian subscriptions](https://quickbooks.intuit.com/learn-support/en-ca/help-article/purchase-orders/reports-included-quickbooks-online-subscription/L0s4KrGgr_CA_en_CA)
   separates subscription availability and additional Payroll entitlement.
   Product availability, API access, manual work and company evidence therefore
   need separate labels. The project's 48 reports are its catalog scope, not the
   total number of reports in QuickBooks.
3. [Intuit: running reports](https://quickbooks.intuit.com/learn-support/en-us/help-article/report-management/run-reports-quickbooks-online/L7aILHhbl_US_en_US)
   makes accounting basis part of report setup. The local report catalog adds
   explicit periods, expected content and accounting relationships. A report
   name or successful response cannot certify the target accounting story.
4. [NN/g: context in data presentation](https://www.nngroup.com/articles/choosing-chart-types/)
   explains why comparisons need context and why related values should be
   positioned together. Show intended outcome beside observed evidence. Avoid
   an aggregate percent with an incomplete denominator or unverified numerator.
5. [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
   supports a clear first level with an obvious route to detailed requirements.
   The overview must expose the business purpose and required breadth; it must
   not hide all meaning behind generic completion labels.
6. [GOV.UK: tabs](https://design-system.service.gov.uk/components/tabs/)
   describes tabs as an option for regular users and warns that they hide
   content. Keep the target and its meaning visible on entry; use clearly named
   modes for feature requirements, report requirements and company record data.

## Chosen experience

1. **Overview, default:** intended business lines, initial history target,
   capability/report scope, saved publication/calendar state and a domain map
   comparing the required outcome with the limits of currently available
   evidence. Explicitly identify Advanced features not yet mapped in the catalog.
2. **Feature requirements:** browse all canonical capability areas by domain and
   priority; select one to compare its purpose, required variations and
   prerequisites with actual record observations and unresolved proof. Existing
   record matches never turn into a target-level covered verdict automatically.
3. **Report requirements:** browse all catalog report definitions, their business
   question, required periods and expected accounting content; open the existing
   report evidence workflow for retained company findings. No fabricated result.
4. **Company data:** retain the recent feature-presence view as supporting
   evidence with local filters and its existing record-type links.

Keep native company scope bound to actor, realm, environment and connection.
Disconnects or read failures must leave the intended scope visible and mark
the company comparison unavailable. Draft settings must not be presented as
published authority. A published calendar cursor proves only its named managed
period checks, not every feature, report or reconciliation requirement.

## Acceptance evidence

- The first screen answers what business, historical depth, functional breadth
  and report coverage the app is intended to deliver.
- Every canonical capability and report is reachable; required variants and
  conditional scope are retained without silent omission.
- An operator can move from an intended capability to its company data and from
  an intended report to its existing evidence page.
- No record-presence result, catalog status, failed request or missing manual
  observation becomes an invented coverage verdict.
- Focused non-live model tests, build/lint, independent implementation review,
  and desktop inspection of the actual running app verify the delivered slice.
  No QBO writes, database writes, provider calls or service control are needed.
