# Implementation Reviewer Memory

- [intuit-oauth@4.2.2 makeApiCall error shape](project_intuit-oauth-422-error-shape.md) — which HTTP statuses resolve vs throw (4xx resolves, 5xx throws) and each shape; load-bearing for qbo-client.js reviews
- [qbo-client throws on 4xx (commit 043bb30)](project_qbo-client-throws-on-4xx-regression.md) — apiCall now throws on QBO errors; qbo-error.respondQboError maps to 502/429; no caller inspected .Fault
