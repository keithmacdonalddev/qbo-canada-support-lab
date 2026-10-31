# QuickBooks faults and fixes

A fault arrives as `Fault.Error[]` with `code`, `Message`, `Detail` and an `intuit_tid` (keep it as evidence). The app maps upstream failures to a 502 with the QuickBooks message.

| Code / status | Meaning | Fix |
| --- | --- | --- |
| 5010 Stale Object Error | The SyncToken you sent is old; the record changed after you read it. | Re-read, check what changed, decide again, resend with the new SyncToken. |
| 6240 Duplicate Name Exists | DisplayName used by another customer, supplier or employee (active or inactive). | Choose a different name; never reuse names listed as unusable. |
| 6140 Duplicate Document Number | DocNumber already used and duplicate checking is on. | Omit DocNumber (auto-number) or choose a new one. |
| 6000 Business Validation Error | A business rule failed; the Detail says which. Common in Canada: "Make sure all your transactions have a GST/HST rate before you save". | Add a TaxCodeRef to every line; fix the rule named in Detail. |
| 610 Object Not Found | A ref names a deleted or inactive record. | Read the current record; use an active one. |
| 2500 Invalid Reference Id | A ref value does not exist in this company. | Never guess ids; read them. |
| 2020 Required Param Missing | A required field is absent. | Add it (see the entity reference). |
| 2010 Request has invalid or unsupported property | Unknown field or a field not allowed for this minor version. | Remove it; check the entity schema. |
| 6190 Invalid Company Status (verify code) | Subscription or company state blocks writes. | Owner/UI matter; record it and stop writes. |
| 6210 Account Period Closed (verify code) | The date is on or before the company's closing date. | Use an open date. |
| 400 with "Amount is not equal to UnitPrice * Qty" | Line amount does not match. | Recompute Amount. |
| "Transaction must balance" (journal) | Debits and credits differ. | Fix lines so they balance. |
| 401 | Access token expired or revoked. | The app refreshes tokens; never report it as the owner's session ending. |
| 429 | Throttled. | The client backs off and retries; reduce reads. |
| 5xx / timeout | QuickBooks failed or may have saved anyway. | Treat the write as possibly sent: check before retrying (the app's recovery does this). |

A write that timed out may have been saved. Never resend it as new; re-read by DocNumber, amount and date, or let the app's recovery workflow continue the operation.
