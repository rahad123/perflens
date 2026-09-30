#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const entry = join(__dirname, '../dist/index.js');
if (!existsSync(entry)) {
  console.error('PerfLens CLI has not been built. Run pnpm install and pnpm build in the PerfLens checkout.');
  process.exitCode = 1;
} else {
  require(entry);
}
