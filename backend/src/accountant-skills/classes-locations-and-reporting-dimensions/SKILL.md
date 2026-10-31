---
name: classes-locations-and-reporting-dimensions
description: Execute class and location coverage with manageQboRecord, correct line/header placement, existing tracking preferences and reports by division/location. Use before dimensioned sales, purchases or journals and in the weekly mix review; prove actual use from saved records.
---

# Classes and locations

Contract source-checked 2026-10-31, **not live-verified**. Use qbo-api-records for general write/recovery rules. Older claims that no tool creates classes/locations are superseded by manageQboRecord.

## Read current settings and lists

Discover getEntityDetail, then call through useTool:
`getEntityDetail({type:"Preferences",id:"1"})`.
Inspect AccountingInfoPrefs.ClassTrackingPerTxn, ClassTrackingPerTxnLine and TrackDepartments. Query active lists:
```json
{"mode":"find","entities":["Class","Department"],"where":[{"field":"Active","op":"ne","value":false}],"fields":["_entity","Id","Name","Active"],"limit":200}
```
Intended divisions: Field & Advisory, Supply & Workshop, Care Plans; locations Halifax, Dartmouth. Treat those as intended names until actual lists/settings confirm them. Never invent IDs or silently change company preferences to manufacture coverage. If disabled, record one owner decision for tracking policy and continue ordinary work.

If tracking is enabled but a genuinely needed list entry is absent, use:
```json
{
  "decisionKey":"dimensions_20261031_care_halifax",
  "purpose":"Create missing reporting dimensions for the actual care service division",
  "operations":[
    {"ref":"care-class","op":"create","entity":"Class","payload":{"Name":"Care Plans"}},
    {"ref":"halifax-location","op":"create","entity":"Department","payload":{"Name":"Halifax"}}
  ]
}
```
Remove operations for entries that already exist; recheck duplicate names first. General same-plan later operations can use the earlier create's $ref. There is no need to create new classes every week.

## Placement on supported new records

- Per-line sales class: `Line[].SalesItemLineDetail.ClassRef:{"value":"<CLASS_ID>"}`.
- Per-line expense class: `Line[].AccountBasedExpenseLineDetail.ClassRef` or `ItemBasedExpenseLineDetail.ClassRef`.
- Invoice/Estimate/SalesReceipt/CreditMemo/RefundReceipt may carry header ClassRef for per-transaction tracking. Use the setting's appropriate location, not both modes indiscriminately.
- Location: `DepartmentRef:{"value":"<LOCATION_ID>"}` on the supported Invoice/sales form/Bill/PurchaseOrder/Purchase/Deposit/BillPayment header.
- JournalEntry: put ClassRef and DepartmentRef inside each JournalEntryLineDetail (no header DepartmentRef in this schema).
- TimeActivity supports ClassRef and DepartmentRef directly. Payment and Transfer do not support arbitrary dimension headers; do not force them into a payload.
- Read getQboEntitySchema for each unfamiliar entity. Fixed workflows do not accept extra class/location fields; use general writes for dimensioned non-inventory activity.

Use actual division and service location. New current-day records carry dimensions from the start. Do not rewrite verified history to fill missing dimensions; retain unclassified historical amounts as a report limitation.

## Verify weekly use and reports

Find actual line assignments:
```json
{
  "mode":"aggregate","entities":["Invoice","SalesReceipt"],
  "where":[{"field":"TxnDate","op":"gte","value":"<SEVEN_DAY_START>"}],
  "unwind":"Line",
  "groupBy":[{"field":"Line.SalesItemLineDetail.ClassRef.value"}],
  "metrics":[{"op":"count"},{"op":"sum","field":"Line.Amount"}]
}
```
Use a separate header-level query grouped by DepartmentRef.value. Inspect complete lines if aggregate output omits a missing dimension. No customer/item-name inference counts as actual class coverage.

Discover runReport; use:
`runReport({report:"ProfitAndLoss",startDate:"<MONTH_START>",endDate:"<MONTH_END>",accountingMethod:"Accrual",summarizeColumnBy:"Classes"})`,
then the same call with summarizeColumnBy Departments. Page all rows and explain Not specified amounts. Check each intended active class/location has meaningful saved activity over seven days, if real demand supports it.

Projects, enhanced custom fields and tags are separate features. This schema does not make them available merely because dimensions work. Keep their gaps explicit; do not claim project profitability from an ordinary customer label.
