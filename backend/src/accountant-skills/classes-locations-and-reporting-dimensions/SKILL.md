---
name: classes-locations-and-reporting-dimensions
description: Reporting dimensions: classes (the three divisions), locations (Halifax, Dartmouth), projects, custom fields; enabling, setting on records and reporting by them. Use when analysing by division or location or planning dimension coverage.
---

# Classes, locations and reporting dimensions

## This company's intended dimensions (business profile)
- **Classes** (divisions): Field & Advisory, Supply & Workshop, Care Plans.
- **Locations**: Halifax, Dartmouth.
- **Projects**: named client projects under service customers.
- **Custom fields**: Support scenario, Service region, Project lead.
Whether each is enabled and populated is a live fact: read Preferences (`AccountingInfoPrefs.ClassTrackingPerTxn`, `ClassTrackingPerTxnLine`, `TrackDepartments`, `DepartmentTerminology`) and the Class/Department lists before claiming anything.

## How they work in QuickBooks
- **Class**: `ClassRef` on each line (when class tracking is per line) or on the transaction. Hierarchical (`ParentRef`). One class per line.
- **Location** (`Department` in the API): `DepartmentRef` on the whole transaction. One location per transaction.
- **Projects**: a project is a special sub-customer; transactions for the customer job roll up in project profitability (Canada API availability: verify).
- **Custom fields** (Advanced): up to 12 per form (verify); API access to enhanced custom fields is limited; legacy `CustomField` holds three string fields on sales forms.
- **Tags**: UI-only labels, not in the Accounting API.
- Enabling class or location tracking is a company setting (owner/UI). Creating classes and locations through the API is supported (`Class`, `Department` create) once enabled.

## Reports
- `runReport` ProfitAndLoss with `summarize_column_by=Classes` or `Departments`; ClassSales; DepartmentSales; ProfitAndLossDetail filtered by class.
- Through the local copy: `queryCompanyData` grouping on `Line.ClassRef.name` or `DepartmentRef.name`.
- Unclassified amounts show in a "Not specified" column; a large one means lines are missing classes.

## Status in this app
- No tool yet creates classes or locations or sets them on new records (catalog: Class and Location "not built"). When the business needs division reporting, file `requestCapability` once (for example key `class-and-location-tracking`, feature ClassSales / DepartmentSales / P&L by class).

## Checklist
- [ ] Never claim division or location results unless records actually carry classes or locations.
- [ ] Analyse by division from item and account (field service, care plans, supply) when classes are absent, and say so.
