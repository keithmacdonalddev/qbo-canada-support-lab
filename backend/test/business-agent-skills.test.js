'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSkillLibrary, parseSkill, SKILLS_DIR, LIMITS } = require('../src/modules/business-agent-skills');

const EXPECTED = ['qbo-api-records', 'canadian-sales-tax', 'receivables-and-collections', 'payables-and-payment-runs', 'inventory-and-purchasing', 'banking-and-deposits', 'month-end-and-year-end-close', 'payroll-and-time', 'classes-locations-and-reporting-dimensions', 'multicurrency', 'business-analysis-and-advice', 'running-a-medium-sized-business-day', 'support-scenarios-for-troubleshooting', 'feature-coverage', 'daily-management-review'];

test('every shipped skill has valid frontmatter, a matching name and stays within size limits', () => {
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of EXPECTED) assert.ok(dirs.includes(name), name + ' exists');
  for (const name of dirs) {
    const source = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const parsed = parseSkill(source);
    assert.ok(parsed, name + ' has frontmatter');
    assert.equal(parsed.meta.name, name);
    assert.match(parsed.meta.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(parsed.meta.description.length >= 80 && parsed.meta.description.length <= LIMITS.descriptionChars, name + ' description length');
    assert.match(parsed.meta.description, /\bUse (when|before|in)\b/, name + ' says when to use it');
    assert.ok(parsed.body.split('\n').length <= LIMITS.bodyLines, name + ' body under the line limit');
    assert.ok(Buffer.byteLength(parsed.body) <= LIMITS.bodyBytes, name + ' body under the byte limit');
    // Every linked reference exists, one level deep.
    for (const [, file] of parsed.body.matchAll(/\]\(reference\/([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(SKILLS_DIR, name, 'reference', file)), name + ' links ' + file);
  }
  const library = createSkillLibrary();
  assert.deepEqual(library.list().map(skill => skill.name).sort(), [...dirs].sort());
  const block = library.promptBlock();
  for (const name of EXPECTED) assert.match(block, new RegExp('- ' + name + ': '));
  assert.ok(!/SyncToken/.test(block.split('\n')[0]), 'the index carries descriptions only');
});

test('frontmatter parsing handles quotes, CRLF and missing blocks', () => {
  const parsed = parseSkill('﻿---\r\nname: "demo-skill"\r\ndescription: \'Does a thing. Use when testing.\'\r\n---\r\n# Body\r\nline');
  assert.deepEqual(parsed.meta, { name: 'demo-skill', description: 'Does a thing. Use when testing.' });
  assert.equal(parsed.body, '# Body\nline');
  assert.equal(parseSkill('# no frontmatter'), null);
});

test('loader lists, loads and reads references; rejects traversal and malformed skills', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  try {
    fs.mkdirSync(path.join(dir, 'good-skill', 'reference'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'good-skill', 'SKILL.md'), '---\nname: good-skill\ndescription: Good. Use when testing.\n---\nBody text');
    fs.writeFileSync(path.join(dir, 'good-skill', 'reference', 'detail.md'), 'Reference text');
    fs.writeFileSync(path.join(dir, 'good-skill', 'reference', 'Bad Name.md'), 'ignored');
    fs.mkdirSync(path.join(dir, 'wrong-name')); fs.writeFileSync(path.join(dir, 'wrong-name', 'SKILL.md'), '---\nname: other\ndescription: x\n---\nBody');
    fs.mkdirSync(path.join(dir, 'no-file'));
    fs.writeFileSync(path.join(dir, 'secret.md'), 'outside any skill');
    const library = createSkillLibrary({ dir });
    assert.deepEqual(library.list(), [{ name: 'good-skill', description: 'Good. Use when testing.' }]);
    assert.deepEqual(library.load('good-skill'), { name: 'good-skill', description: 'Good. Use when testing.', instructions: 'Body text', references: ['detail.md'] });
    assert.equal(library.reference('good-skill', 'detail.md').content, 'Reference text');
    for (const file of ['../SKILL.md', '..\\SKILL.md', 'Bad Name.md', 'missing.md', '../../secret.md']) assert.throws(() => library.reference('good-skill', file), /no reference file/);
    for (const name of ['wrong-name', 'no-file', '..', '../good-skill', 'good-skill/../good-skill', 'GOOD-SKILL']) assert.throws(() => library.load(name), /No skill/);
    assert.equal(createSkillLibrary({ dir: path.join(dir, 'missing') }).promptBlock(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
