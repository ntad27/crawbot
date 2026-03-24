#!/usr/bin/env zx

/**
 * bundle-openclaw.mjs
 *
 * Bundles the openclaw npm package with ALL its dependencies (including
 * transitive ones) into a self-contained directory (build/openclaw/) for
 * electron-builder to pick up.
 *
 * pnpm uses a content-addressable virtual store with symlinks. A naive copy
 * of node_modules/openclaw/ will miss runtime dependencies entirely. Even
 * copying only direct siblings misses transitive deps (e.g. @clack/prompts
 * depends on @clack/core which lives in a separate virtual store entry).
 *
 * This script performs a recursive BFS through pnpm's virtual store to
 * collect every transitive dependency into a flat node_modules structure.
 */

import 'zx/globals';

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'build', 'openclaw');
const NODE_MODULES = path.join(ROOT, 'node_modules');

echo`📦 Bundling openclaw for electron-builder...`;

// 1. Resolve the real path of node_modules/openclaw (follows pnpm symlink)
const openclawLink = path.join(NODE_MODULES, 'openclaw');
if (!fs.existsSync(openclawLink)) {
  echo`❌ node_modules/openclaw not found. Run pnpm install first.`;
  process.exit(1);
}

const openclawReal = fs.realpathSync(openclawLink);
echo`   openclaw resolved: ${openclawReal}`;

// 2. Clean and create output directory
if (fs.existsSync(OUTPUT)) {
  fs.rmSync(OUTPUT, { recursive: true });
}
fs.mkdirSync(OUTPUT, { recursive: true });

// 3. Copy openclaw package itself to OUTPUT root
echo`   Copying openclaw package...`;
fs.cpSync(openclawReal, OUTPUT, { recursive: true, dereference: true });

// 4. Recursively collect ALL transitive dependencies via pnpm virtual store BFS
//
// pnpm structure example:
//   .pnpm/openclaw@ver/node_modules/
//     openclaw/          <- real files
//     chalk/             <- symlink -> .pnpm/chalk@ver/node_modules/chalk
//     @clack/prompts/    <- symlink -> .pnpm/@clack+prompts@ver/node_modules/@clack/prompts
//
//   .pnpm/@clack+prompts@ver/node_modules/
//     @clack/prompts/    <- real files
//     @clack/core/       <- symlink (transitive dep, NOT in openclaw's siblings!)
//
// We BFS from openclaw's virtual store node_modules, following each symlink
// to discover the target's own virtual store node_modules and its deps.

const collected = new Map(); // realPath -> packageName (for deduplication)
const queue = []; // BFS queue of virtual-store node_modules dirs to visit

/**
 * Given a real path of a package, find the containing virtual-store node_modules.
 * e.g. .pnpm/chalk@5.4.1/node_modules/chalk -> .pnpm/chalk@5.4.1/node_modules
 * e.g. .pnpm/@clack+core@0.4.1/node_modules/@clack/core -> .pnpm/@clack+core@0.4.1/node_modules
 */
function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'node_modules') {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * List all package entries in a virtual-store node_modules directory.
 * Handles both regular packages (chalk) and scoped packages (@clack/prompts).
 * Returns array of { name, fullPath }.
 */
function listPackages(nodeModulesDir) {
  const result = [];
  if (!fs.existsSync(nodeModulesDir)) return result;

  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (entry === '.bin') continue;

    const entryPath = path.join(nodeModulesDir, entry);
    const stat = fs.lstatSync(entryPath);

    if (entry.startsWith('@')) {
      // Scoped package: read sub-entries
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        const resolvedScope = stat.isSymbolicLink() ? fs.realpathSync(entryPath) : entryPath;
        // Check if this is actually a scoped directory or a package
        try {
          const scopeEntries = fs.readdirSync(entryPath);
          for (const sub of scopeEntries) {
            result.push({
              name: `${entry}/${sub}`,
              fullPath: path.join(entryPath, sub),
            });
          }
        } catch {
          // Not a directory, skip
        }
      }
    } else {
      result.push({ name: entry, fullPath: entryPath });
    }
  }
  return result;
}

// Start BFS from openclaw's virtual store node_modules
const openclawVirtualNM = getVirtualStoreNodeModules(openclawReal);
if (!openclawVirtualNM) {
  echo`❌ Could not determine pnpm virtual store for openclaw`;
  process.exit(1);
}

echo`   Virtual store root: ${openclawVirtualNM}`;
queue.push({ nodeModulesDir: openclawVirtualNM, skipPkg: 'openclaw', parentRealPath: openclawReal });

// Track dependency edges with the parent's real path so we know which specific
// version of the parent needs each dep. This prevents nesting deps under the
// wrong version when multiple major versions of a package coexist.
const depEdges = []; // { parentName, parentRealPath, dep, depRealPath }

while (queue.length > 0) {
  const { nodeModulesDir, skipPkg, parentRealPath } = queue.shift();
  const packages = listPackages(nodeModulesDir);

  for (const { name, fullPath } of packages) {
    // Skip the package that owns this virtual store entry (it's the package itself, not a dep)
    if (name === skipPkg) continue;

    let realPath;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      continue; // broken symlink, skip
    }

    // Record the dependency edge (parent -> dep) for nesting conflicts later
    if (skipPkg) {
      depEdges.push({ parentName: skipPkg, parentRealPath, dep: name, depRealPath: realPath });
    }

    if (collected.has(realPath)) continue; // already visited
    collected.set(realPath, name);

    // Find this package's own virtual store node_modules to discover ITS deps
    const depVirtualNM = getVirtualStoreNodeModules(realPath);
    if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
      // Determine the package's "self name" in its own virtual store
      // For scoped: @clack/core -> skip "@clack/core" when scanning
      queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name, parentRealPath: realPath });
    }
  }
}

echo`   Found ${collected.size} total packages (direct + transitive)`;

// 5. Copy all collected packages into OUTPUT/node_modules/ (flat structure)
//
// IMPORTANT: BFS guarantees direct deps are encountered before transitive deps.
// When the same package name appears at different versions (e.g. chalk@5 from
// openclaw directly, chalk@4 from a transitive dep), we keep the FIRST one
// (direct dep version) and skip later duplicates. This prevents version
// conflicts like CJS chalk@4 overwriting ESM chalk@5.
const outputNodeModules = path.join(OUTPUT, 'node_modules');
fs.mkdirSync(outputNodeModules, { recursive: true });

const copiedPkgs = new Map(); // pkgName -> { realPath, version }
let copiedCount = 0;
let skippedDupes = 0;

/**
 * Compare two semver-ish version strings. Returns >0 if a>b, <0 if a<b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

for (const [realPath, pkgName] of collected) {
  if (copiedPkgs.has(pkgName)) {
    // When duplicate found, prefer the HIGHER version to ensure newer APIs
    // (like "exports" field in https-proxy-agent v8) are available.
    try {
      const newPkg = JSON.parse(fs.readFileSync(path.join(realPath, 'package.json'), 'utf8'));
      const existing = copiedPkgs.get(pkgName);
      if (compareSemver(newPkg.version, existing.version) > 0) {
        echo`   ↑ Upgrading ${pkgName}: ${existing.version} → ${newPkg.version}`;
        // Overwrite the previously copied version
        const dest = path.join(outputNodeModules, pkgName);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(realPath, dest, { recursive: true, dereference: true });
        copiedPkgs.set(pkgName, { realPath, version: newPkg.version });
      }
    } catch { /* ignore, keep existing */ }
    skippedDupes++;
    continue;
  }
  // Read version for future dedup comparisons
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(realPath, 'package.json'), 'utf8'));
    version = pkg.version || '0.0.0';
  } catch { /* ignore */ }
  copiedPkgs.set(pkgName, { realPath, version });

  const dest = path.join(outputNodeModules, pkgName);

  try {
    // Ensure parent directory exists (for scoped packages like @clack/core)
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(realPath, dest, { recursive: true, dereference: true });
    copiedCount++;
  } catch (err) {
    echo`   ⚠️  Skipped ${pkgName}: ${err.message}`;
  }
}

// 5b. Nest packages with major version conflicts (version-aware)
//
// When the hoisted (flat) version has a different major version than what a
// parent package expects, Node's require() would resolve the wrong major.
// This causes runtime crashes (e.g. signal-exit v4 has named exports but
// proper-lockfile expects v3's default export).
//
// We track WHERE each package version lives in the output tree so that deps
// are nested under the correct parent version — not just by name. This prevents
// accidentally shadowing the hoisted version for packages that need it.

function readVersion(realPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(realPath, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function majorOf(version) {
  return parseInt((version || '0.0.0').split('.')[0], 10);
}

// Map: realPath -> list of output directories where this version lives.
// Initially populated with hoisted locations; grows as we nest.
const outputLocations = new Map(); // realPath -> string[]
for (const [pkgName, { realPath }] of copiedPkgs) {
  outputLocations.set(realPath, [path.join(outputNodeModules, pkgName)]);
}
// openclaw itself lives at the OUTPUT root
outputLocations.set(openclawReal, [OUTPUT]);

let nestedCount = 0;

// Process edges in BFS order (guaranteed by how depEdges was built).
// This ensures parent locations are registered before we process their children.
for (const { parentName, parentRealPath, dep, depRealPath } of depEdges) {
  const hoisted = copiedPkgs.get(dep);
  if (!hoisted) continue;

  // If the dep resolves to the same real path as hoisted, no conflict
  if (depRealPath === hoisted.realPath) continue;

  const depVersion = readVersion(depRealPath);
  const hoistedMajor = majorOf(hoisted.version);
  const depMajor = majorOf(depVersion);

  // Only nest when there's a major version mismatch
  if (hoistedMajor === depMajor) continue;

  // Find all output locations of the SPECIFIC parent version that needs this dep
  const parentLocations = outputLocations.get(parentRealPath);
  if (!parentLocations || parentLocations.length === 0) continue;

  for (const parentLoc of parentLocations) {
    const nestedDest = path.join(parentLoc, 'node_modules', dep);

    // Skip if already nested here (can happen with diamond deps)
    if (fs.existsSync(nestedDest)) continue;

    try {
      fs.mkdirSync(path.dirname(nestedDest), { recursive: true });
      fs.cpSync(depRealPath, nestedDest, { recursive: true, dereference: true });

      // Register this new location so deeper deps can nest under it
      const locs = outputLocations.get(depRealPath) || [];
      locs.push(nestedDest);
      outputLocations.set(depRealPath, locs);

      const parentVersion = readVersion(parentRealPath);
      echo`   🔗 Nested ${dep}@${depVersion} under ${parentName}@${parentVersion} (hoisted: ${dep}@${hoisted.version})`;
      nestedCount++;
    } catch (err) {
      echo`   ⚠️  Failed to nest ${dep} under ${parentName}: ${err.message}`;
    }
  }
}
if (nestedCount > 0) {
  echo`   Nested ${nestedCount} package(s) to resolve major version conflicts`;
}

// 6. Clean up unnecessary files to reduce total file count for code signing
//    This is critical on macOS where every file in the .app bundle gets signed.
const REMOVE_DIRS = new Set([
  'test', 'tests', '__tests__', '__mocks__', '__fixtures__',
  '.github', 'docs', 'examples', 'example',
  'coverage', '.nyc_output', 'benchmark', 'benchmarks',
  'fixtures', 'man', '.vscode', '.idea', 'typings',
]);
const REMOVE_EXTENSIONS = [
  '.d.ts', '.d.ts.map', '.d.mts', '.d.mts.map', '.d.cts', '.d.cts.map',
  '.js.map', '.mjs.map', '.cjs.map', '.ts.map',
  '.ts', '.tsx', '.mts', '.cts',
  '.md', '.markdown', '.rst',
  '.gyp', '.gypi',
  '.o', '.obj', '.a', '.lib',
  '.cc', '.cpp', '.c', '.h', '.hpp',
  '.coffee', '.flow', '.patch', '.tgz',
];
const REMOVE_FILES = new Set([
  '.DS_Store', '.npmignore', '.eslintrc', '.eslintrc.json', '.eslintrc.js',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js',
  'tsconfig.json', 'tsconfig.build.json', 'tslint.json',
  '.editorconfig', '.travis.yml', '.babelrc', '.babelrc.js',
  'Makefile', 'Gruntfile.js', 'Gulpfile.js', 'rollup.config.js',
  'webpack.config.js', 'jest.config.js', 'karma.conf.js',
  'appveyor.yml', '.zuul.yml', 'binding.gyp',
]);

function cleanupDir(dir) {
  let count = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (REMOVE_DIRS.has(entry.name)) {
        try { fs.rmSync(full, { recursive: true, force: true }); count++; } catch {}
      } else {
        count += cleanupDir(full);
      }
    } else if (entry.isFile()) {
      if (REMOVE_FILES.has(entry.name) || REMOVE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        try { fs.rmSync(full, { force: true }); count++; } catch {}
      }
    }
  }
  return count;
}

echo`🧹 Cleaning up unnecessary files in bundle...`;
const cleanedCount = cleanupDir(outputNodeModules);
echo`   Removed ${cleanedCount} unnecessary files/directories`;

// 7. Replace built-in zalo/zalouser with third-party openzalo extension
//
// openzalo (https://github.com/darkamenosa/openzalo) replaces the built-in
// zalo (OA) and zalouser (personal via zca-js) extensions with a unified
// personal Zalo integration via openzca CLI.
const REMOVE_EXTENSIONS_LIST = ['zalo', 'zalouser'];
const THIRD_PARTY_EXTENSIONS = [
  { name: 'openzalo', repo: 'https://github.com/darkamenosa/openzalo.git' },
];

echo`📦 Replacing bundled Zalo extensions with openzalo...`;

// OpenClaw 2026.3.13 uses extensions/ (TS source), 2026.3.22+ uses dist/extensions/ (compiled JS).
// resolveBundledPluginsDir() returns only ONE dir at runtime, so we must place third-party
// extensions in the same dir that will be resolved. Check both locations.
const extensionsDirs = [
  path.join(OUTPUT, 'extensions'),
  path.join(OUTPUT, 'dist', 'extensions'),
].filter(d => fs.existsSync(d));

// Remove built-in zalo and zalouser from all extension locations
for (const extDir of extensionsDirs) {
  for (const ext of REMOVE_EXTENSIONS_LIST) {
    const extPath = path.join(extDir, ext);
    if (fs.existsSync(extPath)) {
      fs.rmSync(extPath, { recursive: true, force: true });
      echo`   🗑️  Removed built-in extension: ${ext} (from ${path.relative(OUTPUT, extDir)})`;
    }
  }
}

// Clone third-party extensions into the first available extensions dir.
// On 2026.3.13: extensions/ (TS source, loaded via Jiti)
// On 2026.3.22+: dist/extensions/ (compiled JS, but Jiti handles TS too)
const thirdPartyExtDir = extensionsDirs[0];
for (const { name, repo } of THIRD_PARTY_EXTENSIONS) {
  const extPath = path.join(thirdPartyExtDir, name);
  if (fs.existsSync(extPath)) {
    fs.rmSync(extPath, { recursive: true, force: true });
  }
  echo`   ⬇️  Cloning ${name} from ${repo}...`;
  // Use forward slashes on Windows to avoid backslash escape interpretation in shell
  const extPathShell = extPath.split(path.sep).join('/');
  await $`git clone --depth 1 ${repo} ${extPathShell}`;
  // Remove .git directory (not needed in bundle, saves space + avoids signing overhead)
  fs.rmSync(path.join(extPath, '.git'), { recursive: true, force: true });
  // Remove dev artifacts
  for (const devDir of ['node_modules', '.github']) {
    const devPath = path.join(extPath, devDir);
    if (fs.existsSync(devPath)) {
      fs.rmSync(devPath, { recursive: true, force: true });
    }
  }
  echo`   ✅ Bundled extension: ${name}`;
}

// 7b. Bundle extra CLI tools required by third-party extensions
//
// openzalo spawns `openzca` CLI binary at runtime. Since openzca is a CrawBot
// npm dependency (not an openclaw dep), the BFS above doesn't collect it.
// Copy openzca + its deps and create a .bin symlink so it's in PATH.
const EXTRA_CLI_PACKAGES = [
  { name: 'openzca', binName: 'openzca', binPath: 'dist/cli.js' },
];

echo`📦 Bundling extra CLI tools...`;
for (const { name, binName, binPath } of EXTRA_CLI_PACKAGES) {
  const pkgLink = path.join(NODE_MODULES, name);
  if (!fs.existsSync(pkgLink)) {
    echo`   ⚠️  ${name} not found in node_modules, skipping`;
    continue;
  }

  const pkgReal = fs.realpathSync(pkgLink);
  const dest = path.join(outputNodeModules, name);

  // Copy the package itself
  if (!fs.existsSync(dest)) {
    fs.cpSync(pkgReal, dest, { recursive: true, dereference: true });
  }

  // Copy its dependencies (resolve from its virtual store node_modules)
  const pkgVirtualNM = getVirtualStoreNodeModules(pkgReal);
  if (pkgVirtualNM) {
    const pkgDeps = listPackages(pkgVirtualNM);
    for (const { name: depName, fullPath: depFullPath } of pkgDeps) {
      if (depName === name) continue; // skip self
      const depDest = path.join(outputNodeModules, depName);
      if (fs.existsSync(depDest)) continue; // already in bundle
      let depReal;
      try { depReal = fs.realpathSync(depFullPath); } catch { continue; }
      try {
        fs.mkdirSync(path.dirname(depDest), { recursive: true });
        fs.cpSync(depReal, depDest, { recursive: true, dereference: true });
      } catch {}
    }
  }

  // Create .bin wrapper script (NOT a symlink — symlinks break macOS codesign)
  const binDir = path.join(outputNodeModules, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binScriptPath = path.join(binDir, binName);
  if (!fs.existsSync(binScriptPath)) {
    const targetPath = path.join('..', name, binPath);
    fs.writeFileSync(binScriptPath, `#!/usr/bin/env node\nrequire("./${targetPath}");\n`, 'utf-8');
    fs.chmodSync(binScriptPath, 0o755);
    try { fs.chmodSync(path.join(outputNodeModules, name, binPath), 0o755); } catch {}
  }
  echo`   ✅ Bundled CLI tool: ${binName} (from ${name})`;
}

// 8. Verify the bundle
const entryExists = fs.existsSync(path.join(OUTPUT, 'openclaw.mjs'));
const distExists = fs.existsSync(path.join(OUTPUT, 'dist', 'entry.js'));

echo``;
echo`✅ Bundle complete: ${OUTPUT}`;
echo`   Unique packages copied: ${copiedCount}`;
echo`   Duplicate versions skipped: ${skippedDupes}`;
echo`   Nested (major version conflicts): ${nestedCount}`;
echo`   Total discovered: ${collected.size}`;
echo`   openclaw.mjs: ${entryExists ? '✓' : '✗'}`;
echo`   dist/entry.js: ${distExists ? '✓' : '✗'}`;

if (!entryExists || !distExists) {
  echo`❌ Bundle verification failed!`;
  process.exit(1);
}

// 9. Log bundled OpenClaw version and extensions
const openclawPkg = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'package.json'), 'utf-8'));
const rootPkgPath = path.join(ROOT, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));

const allExtDirs = [
  path.join(OUTPUT, 'extensions'),
  path.join(OUTPUT, 'dist', 'extensions'),
].filter(d => fs.existsSync(d));
const bundledExts = [...new Set(
  allExtDirs.flatMap(d =>
    fs.readdirSync(d, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  )
)].sort();

echo`   Bundled OpenClaw version: ${openclawPkg.version}`;
echo`   CrawBot version: ${rootPkg.version}`;
echo`   Bundled extensions (${bundledExts.length}): ${bundledExts.join(', ')}`;
