#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const entry = join(__dirname, '../dist/perflens.js');
if (!existsSync(entry)) {
  console.error('PerfLens CLI package is incomplete. Reinstall the package or rebuild the PerfLens workspace.');
  process.exitCode = 1;
} else {
  require(entry);
}
