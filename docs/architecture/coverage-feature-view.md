# Company feature coverage

The Coverage page presents named QuickBooks functionality under **Covered by
company data** and **Missing data or needs verification**. It uses the existing
read-only `/api/coverage` result. It does not show a global completion percentage
or treat the number of successful internal signals as overall company coverage.

`frontend/src/lib/coverage-features.mjs` adapts those results for this view:

- Older matching transactions remain evidence of feature presence. Their age is
  shown separately; age alone does not offer another test case.
- Customer/vendor record-volume shortfalls retain the existing feature data as
  limited. Unmet structural requirements, such as multiple provinces, remain
  incomplete and identify that additional setup data is needed.
- Missing prerequisites, manual verification, and failed reads stay distinct
  from a confirmed absence of data.
- Search and filters operate locally on named features and business areas.

Selecting a feature opens its existing counts, dates, read limitations and
manual instructions. Supported record types link to the existing Explorer;
these links browse that type and do not claim individual matching record IDs.
Related report names are dependencies, not report-verification evidence.

The view covers the server's listed functionality and bounded search period;
it does not establish every QuickBooks feature, full business history, or
reconciled reports. Existing case authorization and backend reads are unchanged.

Focused non-live regression coverage:
`node --test frontend/src/lib/coverage-features.test.mjs`.
