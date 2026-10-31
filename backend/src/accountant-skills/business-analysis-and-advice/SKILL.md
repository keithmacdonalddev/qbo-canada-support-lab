---
name: business-analysis-and-advice
description: Analysis and advice: margins by service, customer and month, cash runway, aging, days to pay, concentration, pricing and seasonality from queryCompanyData aggregates, with healthy ranges and how to turn numbers into advice. Use in the management review or when judging how the business is doing.
---

# Business analysis and advice

## Use the local copy first
`queryCompanyData` reads the synced copy with no QuickBooks request; use `runReport` only to confirm a statement or when freshness says a source is not current. Every result states freshness: say "provisional" when a source is not current.

## Ready-made queries
Sales by month (last 12 months):
```json
{"mode":"aggregate","entities":["Invoice","SalesReceipt"],"where":[{"field":"TxnDate","op":"gte","value":"2025-11-01"}],"groupBy":[{"field":"TxnDate","period":"month"}],"metrics":[{"op":"sum","field":"TotalAmt"},{"op":"count"}],"sort":[{"field":"TxnDate:month"}]}
```
Revenue by item (service mix): add `"unwind":"Line"`, group by `Line.SalesItemLineDetail.ItemRef.name`, sum `Line.Amount`.
Top customers: group Invoice by `CustomerRef.name`, sum `TotalAmt`, sort `[{"field":"sum:TotalAmt","direction":"desc"}]`, limit 10.
AR aging: Invoice where `Balance gt 0`, group by `DueDate` with `"bucket":"aging"`, sum `Balance`.
Who pays late: Invoice where `Balance eq 0`, group by `CustomerRef.name`, avg `_daysLate` and avg `_daysToPay`.
Expenses by supplier: Bill and Purchase grouped by `VendorRef.name` / `EntityRef.name`, sum `TotalAmt`.
Unused records: Customer or Item `find` with fields `DisplayName`/`Name`, then compare with sales grouped by party or item.

## Measures and healthy ranges for this business
| Measure | How | Healthy | Act when |
| --- | --- | --- | --- |
| Gross margin, field services | (revenue − subcontractor/direct cost) ÷ revenue | 50-70% | below 45% two months running |
| Gross margin, supply/workshop | (sales − COGS) ÷ sales | 25-40% | below 20% or negative stock |
| Care-plan revenue share | care income ÷ total | steady, growing slowly | falling three months |
| Net margin | net income ÷ revenue (ProfitAndLoss) | 5-15% | negative two months |
| Days sales outstanding | AR ÷ (revenue ÷ days) | near average terms (20-35) | above 45 |
| AR over 60 days | share of AR | under 10% | above 15% |
| Days payable outstanding | AP ÷ (purchases ÷ days) | 25-40 | above 50 (supplier risk) |
| Cash runway | bank ÷ average monthly operating spend | over 2 months | under 1 month |
| Customer concentration | largest customer ÷ revenue | under 20% | above 25% |
| Seasonality | same month last year | utilities up in winter; field work slower Dec-Feb | an unexplained swing over 30% |

## From numbers to advice
1. State the fact with its period and freshness ("October sales $186k, up 8% on September; data current to 14:05").
2. Explain the driver (customer, item, price, volume, timing).
3. Recommend one concrete action and record it with `recordBusinessDecision` (area business), for example "raise care-plan price 4% at renewal", "hold terms sales to Bayview Marine until 60-day balance is paid", "reorder fasteners: 9 days of stock left".
4. Put durable follow-ups in `rememberBusinessContext` and today's plan.
Never invent a figure: every number cites a query or report you ran in this review.

## Checklist
- [ ] Numbers come from this review's queries; provisional data is labelled.
- [ ] Each finding has a driver and an action, or is clearly informational.
- [ ] Advice fits a medium-sized Nova Scotia services, supply and care-plan business.
