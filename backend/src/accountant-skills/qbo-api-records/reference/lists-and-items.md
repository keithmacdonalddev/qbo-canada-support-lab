# Lists and items

## Customer
- Required: `DisplayName` (unique across customers, suppliers and employees). Useful: `CompanyName`, `GivenName`/`FamilyName`, `PrimaryEmailAddr: { Address }`, `PrimaryPhone: { FreeFormNumber }`, `BillAddr` (`Line1`, `City`, `CountrySubDivisionCode` such as `NS`, `PostalCode`, `Country`), `SalesTermRef`, `PreferredDeliveryMethod`.
- Sub-customer or project: `Job: true`, `ParentRef`, `BillWithParent`. Projects proper are a separate feature (verify Canada API access).
- `Balance` is read-only. Opening balances are not used by this app.

## Vendor (supplier)
- Required: `DisplayName` (same uniqueness rule). Useful: `CompanyName`, `PrimaryEmailAddr`, `TermRef`, `BillAddr`, `AcctNum`, `Vendor1099` is US-only and ignored in Canada.

## Item
- `Type`: `Service`, `NonInventory`, `Inventory`, `Category` (groups), `Bundle` is UI-only for create (verify).
- Service / NonInventory: `Name`, `IncomeAccountRef`; with purchasing also `ExpenseAccountRef`, `PurchaseCost`.
- Inventory: `Name`, `TrackQtyOnHand: true`, `QtyOnHand`, `InvStartDate`, `IncomeAccountRef`, `ExpenseAccountRef` (cost of goods sold), `AssetAccountRef` (inventory asset). Inventory tracking must be on in company settings (Advanced and Plus).
- `UnitPrice` default sale price, `PurchaseCost` default cost, `SalesTaxCodeRef` / `PurchaseTaxCodeRef` default tax.
- Quantity on hand changes only through transactions (bills, sales, inventory adjustments); never by editing `QtyOnHand` on an item with history.

## Term
- `Name`, `DueDays` (standard) or `DayOfMonthDue` / `DueNextMonthDays` (date driven), optional `DiscountPercent` and `DiscountDays` (for example 2% 10, Net 30).

## Class and Department (location)
- `Name`, optional `ParentRef` and `SubClass: true`. Department is shown as Location in this company. Both must be enabled in settings first.

## Employee
- `GivenName`, `FamilyName` (or `DisplayName`), `PrimaryAddr`, `HiredDate`. Payroll fields are not in the Accounting API.

## TaxCode, TaxRate, TaxAgency
- Readable. The Canadian codes (for example HST NS, GST, Zero-rated, Exempt) come from the company's sales tax setup. Creating codes through `TaxService` exists for some regions (verify for Canada); tax setup is an owner/UI action in this app.
