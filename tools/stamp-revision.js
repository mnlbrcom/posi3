#!/usr/bin/env node
'use strict';
/**
 * Write the current git revision where a packaged build can read it.
 *
 * A dev run can read `.git` directly, but the thing an operator is actually
 * holding at a venue is the packaged app — and that has no `.git` at all.
 * Without this step the one build whose revision matters is the one that
 * cannot report it.
 *
 * Run from the dist scripts. The output is gitignored: it describes the
 * commit it was generated from, so committing it would always be one behind.
 *
 *   node tools/stamp-revision.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'revision.json');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const revision = git(['rev-parse', '--short', 'HEAD']);
// A build made from uncommitted work is not the commit it names, and someone
// diagnosing a fault deserves to know that before they go reading that commit.
const dirty = git(['status', '--porcelain']) !== '';

if (!revision) {
  process.stdout.write('stamp-revision: no git revision available — skipping\n');
  process.exit(0);
}

fs.writeFileSync(OUT, `${JSON.stringify({
  revision: dirty ? `${revision}+` : revision,
  builtAt: new Date().toISOString()
}, null, 2)}\n`);
process.stdout.write(`stamp-revision: ${revision}${dirty ? '+ (uncommitted changes)' : ''}\n`);
