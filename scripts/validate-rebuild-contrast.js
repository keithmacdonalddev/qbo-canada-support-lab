'use strict';

const fs = require('fs');
const path = require('path');

const tokenPath = path.resolve(__dirname, '../frontend/src/styles/rebuild-tokens.css');
const css = fs.readFileSync(tokenPath, 'utf8');

function block(pattern, label) {
  const match = css.match(pattern);
  if (!match) throw new Error(`Missing ${label} token block in ${tokenPath}`);
  return Object.fromEntries(
    [...match[1].matchAll(/(--tdl-[\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)].map((entry) => [entry[1], entry[2]])
  );
}

function channels(value) {
  const hex = value.slice(1);
  const normalized = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex.slice(0, 6);
  return normalized.match(/../g).map((pair) => Number.parseInt(pair, 16) / 255);
}

function luminance(value) {
  const [red, green, blue] = channels(value).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const themes = {
  light: block(/:root\s*{([\s\S]*?)\n}/, 'light'),
  dark: block(/\.tdl-dark,\s*\n\[data-tdl-theme="dark"\]\s*{([\s\S]*?)\n}/, 'dark')
};

const pairs = [
  ['--tdl-text-primary', '--tdl-canvas'],
  ['--tdl-text-primary', '--tdl-surface'],
  ['--tdl-text-secondary', '--tdl-canvas'],
  ['--tdl-text-tertiary', '--tdl-canvas'],
  ['--tdl-text-link', '--tdl-surface'],
  ['--tdl-text-on-accent', '--tdl-accent'],
  ['--tdl-text-on-accent', '--tdl-accent-hover'],
  ['--tdl-success', '--tdl-success-soft'],
  ['--tdl-warning', '--tdl-warning-soft'],
  ['--tdl-danger', '--tdl-danger-soft'],
  ['--tdl-unknown', '--tdl-unknown-soft'],
  ['--tdl-production', '--tdl-production-soft'],
  ['--tdl-disabled', '--tdl-disabled-soft']
];

const failures = [];
const results = [];
for (const [themeName, tokens] of Object.entries(themes)) {
  for (const [foregroundKey, backgroundKey] of pairs) {
    const foreground = tokens[foregroundKey];
    const background = tokens[backgroundKey];
    if (!foreground || !background) {
      failures.push(`${themeName}: missing ${!foreground ? foregroundKey : backgroundKey}`);
      continue;
    }
    const ratio = contrast(foreground, background);
    results.push({ theme: themeName, foregroundKey, backgroundKey, ratio });
    if (ratio < 4.5) failures.push(`${themeName}: ${foregroundKey} on ${backgroundKey} is ${ratio.toFixed(2)}:1`);
  }
}

if (failures.length) {
  console.error(`Rebuild contrast validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

const lowest = results.reduce((minimum, result) => (result.ratio < minimum.ratio ? result : minimum));
console.log(`Rebuild contrast validation passed: ${results.length} semantic text pairs at or above 4.5:1.`);
console.log(`Lowest checked pair: ${lowest.theme} ${lowest.foregroundKey} on ${lowest.backgroundKey} at ${lowest.ratio.toFixed(2)}:1.`);
