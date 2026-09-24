#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dirname, '../../backend/src');
const files = [];
const pending = [sourceRoot];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pending.push(path);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
}

let failures = 0;
for (const path of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error) {
    failures += 1;
    process.stderr.write(`${path}: syntax check failed\n${result.stderr || result.error?.message || ''}`);
  }
}
process.stdout.write(`Checked ${files.length} backend JavaScript files; ${failures} failed.\n`);
process.exitCode = failures ? 1 : 0;
