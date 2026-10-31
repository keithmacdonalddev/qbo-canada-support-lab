'use strict';
// The accountant's skills: procedural knowledge loaded on demand (three-level progressive
// disclosure, as in Anthropic Agent Skills). Level 1 is each skill's name and description,
// listed in every review's instructions. Level 2 is the SKILL.md body, returned by loadSkill.
// Level 3 is one optional reference/<file>.md, returned by readSkillReference.
// Files are read on each call (they are small and change without a server reload). Only
// skill directory names and reference file names found on disk are accepted, so no request
// path can leave the skills directory.
const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.join(__dirname, '..', 'accountant-skills');
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/, REFERENCE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
const LIMITS = Object.freeze({ descriptionChars: 1024, bodyLines: 500, bodyBytes: 40000, referenceBytes: 40000, skills: 40, references: 12 });

const problem = message => Object.assign(new Error(message), { status: 400, code: 'BUSINESS_SKILL_UNAVAILABLE' });
const unquote = value => /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;

// Frontmatter is the leading block between two --- lines, holding single-line `key: value` pairs.
function parseSkill(source) {
  const text = String(source).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (pair) meta[pair[1]] = unquote(pair[2].trim());
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function createSkillLibrary({ dir = SKILLS_DIR } = {}) {
  const directories = () => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.filter(entry => entry.isDirectory() && NAME.test(entry.name)).map(entry => entry.name).sort().slice(0, LIMITS.skills);
  };
  // A skill whose file is missing or malformed is left out rather than failing the review.
  function read(name) {
    if (typeof name !== 'string' || !NAME.test(name) || !directories().includes(name)) return null;
    let parsed;
    try { parsed = parseSkill(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8')); } catch { return null; }
    if (!parsed || parsed.meta.name !== name || !parsed.meta.description || parsed.meta.description.length > LIMITS.descriptionChars) return null;
    let references = [];
    try { references = fs.readdirSync(path.join(dir, name, 'reference'), { withFileTypes: true }).filter(entry => entry.isFile() && REFERENCE.test(entry.name)).map(entry => entry.name).sort().slice(0, LIMITS.references); } catch { /* no references */ }
    return { name, description: parsed.meta.description, body: parsed.body, references };
  }
  function list() {
    return directories().map(read).filter(Boolean).map(({ name, description }) => ({ name, description }));
  }
  function load(name) {
    const skill = read(name);
    if (!skill) throw problem('No skill is named "' + String(name).slice(0, 80) + '". Use listSkills for the available names.');
    return { name: skill.name, description: skill.description, instructions: skill.body.slice(0, LIMITS.bodyBytes), references: skill.references };
  }
  function reference(name, file) {
    const skill = read(name);
    if (!skill) throw problem('No skill is named "' + String(name).slice(0, 80) + '". Use listSkills for the available names.');
    if (typeof file !== 'string' || !REFERENCE.test(file) || !skill.references.includes(file)) throw problem('The skill ' + name + ' has no reference file "' + String(file).slice(0, 80) + '". Its references: ' + (skill.references.join(', ') || 'none') + '.');
    const content = fs.readFileSync(path.join(dir, name, 'reference', file), 'utf8').replace(/\r\n/g, '\n');
    return { name, file, content: content.slice(0, LIMITS.referenceBytes) };
  }
  // The level-1 index for the review's instructions: names and descriptions only.
  function promptBlock() {
    const skills = list();
    if (!skills.length) return '';
    return 'Skills (your procedures and reference knowledge, loaded on demand). Before unfamiliar or specialised work, call loadSkill with the skill name and follow it; a skill names its reference files, read with readSkillReference only when needed. Available skills:\n' + skills.map(skill => '- ' + skill.name + ': ' + skill.description).join('\n');
  }
  return { list, load, reference, promptBlock, dir };
}

module.exports = { createSkillLibrary, parseSkill, SKILLS_DIR, LIMITS };
