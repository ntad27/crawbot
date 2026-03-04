/**
 * Environment Polyfill Helper
 *
 * On macOS, the packaged Electron Helper binary disables process.env for
 * security (node_main.cc:148). This causes Node.js ESM internals to crash
 * when loading ESM-only dependencies from CJS (hasOwnProperty on null env).
 *
 * This module provides a helper to inject a --require polyfill that restores
 * process.env from a temp JSON file before the target script runs.
 *
 * The env file path is hardcoded into the generated polyfill script (not
 * passed as a CLI arg) because the Electron binary rejects unknown options.
 */
import { app } from 'electron';
import path from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';

/**
 * Build the polyfill source with the env file path baked in.
 * This avoids passing custom CLI args that Electron rejects.
 */
function buildPolyfillSource(envFilePath: string): string {
  // Use JSON.stringify to safely embed the path as a string literal
  const safePath = JSON.stringify(envFilePath);
  return `'use strict';
// Always restore env: Electron Helper sets process.env to empty {} (not null),
// so we must populate it with the saved environment variables unconditionally.
var envData = {};
try {
  var fs = require('fs');
  var raw = fs.readFileSync(${safePath}, 'utf-8');
  var parsed = JSON.parse(raw);
  for (var key in parsed) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      envData[key] = parsed[key];
    }
  }
  try { fs.unlinkSync(${safePath}); } catch (_e) {}
} catch (_err) {}
if (!process.env || typeof process.env !== 'object') {
  Object.defineProperty(process, 'env', {
    value: envData, writable: true, configurable: true, enumerable: true
  });
} else {
  for (var k in envData) {
    if (Object.prototype.hasOwnProperty.call(envData, k)) {
      process.env[k] = envData[k];
    }
  }
}
`;
}

/**
 * Prepare env polyfill args for a child process spawned with the Electron binary.
 *
 * In packaged mode, writes the spawn environment to a temp JSON file and returns
 * args to prepend (just --require polyfill.cjs, no custom flags).
 *
 * In dev mode, returns an empty array (no polyfill needed).
 */
export function prepareEnvPolyfillForChild(
  spawnEnv: Record<string, string | undefined>,
): string[] {
  if (!app.isPackaged) return [];

  const tmpDir = path.join(app.getPath('temp'), 'crawbot');
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  // Write spawn environment to a temp file
  const envFilePath = path.join(tmpDir, `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const envObj: Record<string, string> = {};
  for (const [key, value] of Object.entries(spawnEnv)) {
    if (value !== undefined) {
      envObj[key] = value;
    }
  }
  writeFileSync(envFilePath, JSON.stringify(envObj), 'utf-8');

  // Write the polyfill script with the env path baked in
  // Each spawn gets a unique polyfill to avoid race conditions
  const polyfillPath = path.join(tmpDir, `env-polyfill-${Date.now()}.cjs`);
  writeFileSync(polyfillPath, buildPolyfillSource(envFilePath), 'utf-8');

  return ['--require', polyfillPath];
}
