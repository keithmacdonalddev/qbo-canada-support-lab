'use strict';
function nestedReport(report, levels = 8) {
  const copy = structuredClone(report);
  for (let index = 0; index < levels; index++) copy.Rows.Row = [{ type: 'Section', group: 'fixture-wrapper-' + index, Rows: { Row: copy.Rows.Row } }];
  return copy;
}
module.exports = { nestedReport };
