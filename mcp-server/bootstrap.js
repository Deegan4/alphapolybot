#!/usr/bin/env node

/**
 * MCP Server Bootstrap
 * Auto-installs dependencies and builds TypeScript on first run.
 * All logging goes to stderr (stdout is reserved for MCP protocol).
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(__dirname, 'node_modules');
const distDir = join(__dirname, 'dist');

// Install dependencies if missing
if (!existsSync(nodeModules)) {
  process.stderr.write('[polymarket-mcp] Installing dependencies (first run)...\n');
  execSync('npm install --silent', { cwd: __dirname, stdio: ['pipe', 'pipe', 'inherit'] });
  process.stderr.write('[polymarket-mcp] Dependencies installed.\n');
}

// Build TypeScript if dist/ is missing
if (!existsSync(distDir)) {
  process.stderr.write('[polymarket-mcp] Building TypeScript...\n');
  execSync('npx tsc', { cwd: __dirname, stdio: ['pipe', 'pipe', 'inherit'] });
  process.stderr.write('[polymarket-mcp] Build complete.\n');
}

// Launch the actual server
await import('./dist/index.js');
