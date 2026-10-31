---
name: payroll-and-time
description: Payroll and time in Canada through the API: employees, time activities, billable hours, payroll as summary journals, CPP/EI/tax deductions, and what is impossible (running payroll, T4s, remittance filing). Use when staff time, billable hours or payroll come up.
---

# Payroll and time

## What the API can do in Canada
| Need | API | This app |
| --- | --- | --- |
| Employees | `Employee` create/read/update | No tool yet (`requestCapability`) |
| Time entries | `TimeActivity` create/read (`NameOf: "Employee"` or `"Vendor"`, `EmployeeRef`/`VendorRef`, `CustomerRef`, `ItemRef`, `Hours`/`Minutes`, `BillableStatus`, `HourlyRate`, `TxnDate`) | Created inside field-service sales (billable technician hours linked to the estimate and invoice) |
| Billable time on invoices | Invoice linked to the TimeActivity | Done by the field-service sale |
| Running payroll, paycheques, pay stubs | Not in the Accounting API (QuickBooks Payroll is UI/partner only) | Not possible |
| T4, ROE, PD7A remittance filing | Not in the API | Not possible |
| Payroll summary as accounting | `JournalEntry` | Journal entries to payroll liability accounts are not allowed by the current journal-entry activity (`requestCapability`) |

## Recording payroll without QuickBooks Payroll (summary journal per pay run)
Typical bi-weekly entry:
- Debit wages expense (gross pay) and employer CPP and EI expense.
- Credit CPP payable (employee + employer), EI payable (employee + 1.4 × employee), income tax withheld payable, and the bank or payroll clearing account (net pay).
- Remit source deductions to the CRA monthly by the 15th of the next month for most small employers (regular remitter).
- Rates change every January (verify current year): CPP about 5.95% each for employee and employer on earnings above the $3,500 basic exemption up to the yearly maximum, plus CPP2 above it; EI about 1.6% employee, employer 1.4 times that.

## Modelling staff believably
- This business has a field technician role, a finance manager, a project coordinator, an inventory lead and a support analyst. Field hours drive service invoices.
- Billable utilisation for technicians about 65-80%; non-billable time (training, travel) exists too.
- Wages are usually the largest operating cost in a services business: when payroll entries become possible, keep total payroll at a believable share of revenue (about 35-50% for field services).

## Checklist
- [ ] Time entries only through the tools that create them; hours plausible per day (no technician over about 10 billable hours).
- [ ] Never claim payroll was run, paycheques issued or remittances filed.
- [ ] Missing payroll capabilities (employees, payroll journal, remittance bills) requested once each.
