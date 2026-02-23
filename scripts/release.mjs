#!/usr/bin/env zx

/**
 * Release Script
 *
 * Automates the release process:
 *   pnpm release:prepare         — update openclaw if newer, bump version, commit, tag, push
 *   pnpm release:prepare --rebuild  — bump build number only (no openclaw update), commit, tag, push
 *
 * Version format: YYYY.M.DD-BUILD  (e.g. 2026.2.22-2)
 *   - On openclaw update: app version syncs to openclaw version
 *   - On rebuild: build suffix increments (2026.2.22-2 → 2026.2.22-3)
 */

const isRebuild = argv.rebuild || argv.r;

// Read current package.json
const pkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
const currentVersion = pkg.version;
const currentOpenclaw = pkg.dependencies?.openclaw;

echo`Current app version: ${currentVersion}`;
echo`Current openclaw:    ${currentOpenclaw}`;

let newVersion;
let commitMessage;

if (isRebuild) {
  // Rebuild mode: just bump the build suffix
  const [base, build] = currentVersion.split('-');
  const nextBuild = (parseInt(build || '1', 10) + 1).toString();
  newVersion = `${base}-${nextBuild}`;
  commitMessage = `chore: rebuild ${newVersion}`;
  echo`\nRebuild mode — bumping build number: ${currentVersion} → ${newVersion}`;
} else {
  // Release mode: check for newer openclaw
  echo`\nChecking for newer openclaw on npm...`;
  const latestOpenclaw = (await $`npm view openclaw version`).stdout.trim();
  echo`Latest openclaw:     ${latestOpenclaw}`;

  if (latestOpenclaw === currentOpenclaw) {
    echo`\nOpenclaw is already up to date. Bumping build number instead.`;
    const [base, build] = currentVersion.split('-');
    const nextBuild = (parseInt(build || '1', 10) + 1).toString();
    newVersion = `${base}-${nextBuild}`;
    commitMessage = `chore: rebuild ${newVersion}`;
  } else {
    echo`\nUpdating openclaw: ${currentOpenclaw} → ${latestOpenclaw}`;
    await $`pnpm add openclaw@${latestOpenclaw}`;
    newVersion = latestOpenclaw;
    commitMessage = `chore: bump openclaw to ${latestOpenclaw} and sync app version`;
  }
}

// Update version in package.json
echo`\nSetting app version to ${newVersion}`;
const updatedPkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
updatedPkg.version = newVersion;
await fs.writeFile('package.json', JSON.stringify(updatedPkg, null, 4) + '\n', 'utf-8');

// Stage, commit, tag, push
echo`\nCommitting and tagging v${newVersion}...`;
await $`git add package.json pnpm-lock.yaml`;
await $`git commit -m ${commitMessage + '\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'}`;
await $`git tag v${newVersion}`;
await $`git push`;
await $`git push --tags`;

echo`\nDone! Release v${newVersion} pushed and tagged.`;
echo`GitHub Actions should start the build now.`;
