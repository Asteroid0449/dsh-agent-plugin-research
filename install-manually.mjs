// Manual install helper for dsh-agent-plugin-research.
//
// Why: when Git Bash / pnpm is unavailable, this script copies the plugin into
// the profile's node_modules and updates the profile manifest directly. It only
// touches `$DSH_HOME/profiles/<profile>` and refuses to remove anything else.
//
// Usage:
//   node install-manually.mjs [--profile web] [--dry-run]
//
// Dry-run prints what would change without writing anything.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const sourceManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const pluginName = sourceManifest.name
const pluginVersion = sourceManifest.version
if (pluginName !== 'dsh-agent-plugin-research' || typeof pluginVersion !== 'string'
  || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pluginVersion)) {
  throw new Error('the adjacent package.json has an unexpected name or invalid version')
}

function parseArgs(argv) {
  let profile = 'web'
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length)
    else if (arg === '--profile') { /* handled below */ }
  }
  const profileIndex = argv.indexOf('--profile')
  if (profileIndex !== -1 && argv[profileIndex + 1] !== undefined) profile = argv[profileIndex + 1]
  return { profile, dryRun }
}

function assertProfileName(profile) {
  if (profile === '' || profile === '.' || profile === '..' || profile === 'node_modules'
    || profile.includes('/') || profile.includes('\\')) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const to = join(dest, entry)
    if (statSync(from).isDirectory()) copyDir(from, to)
    else copyFileSync(from, to)
  }
}

function copyPlugin(targetPackageDir) {
  mkdirSync(targetPackageDir, { recursive: true })
  copyFileSync(join(pluginDir, 'package.json'), join(targetPackageDir, 'package.json'))
  copyFileSync(join(pluginDir, 'cordis.patch.yml'), join(targetPackageDir, 'cordis.patch.yml'))
  copyDir(join(pluginDir, 'lib'), join(targetPackageDir, 'lib'))
}

function install(profile, dryRun) {
  assertProfileName(profile)
  const profileDir = join(dshHome(), 'profiles', profile)
  const targetPackageDir = join(profileDir, 'node_modules', pluginName)
  const manifestPath = join(profileDir, 'package.json')

  if (!existsSync(profileDir)) {
    if (dryRun) {
      console.log(`[dry-run] would create profile directory: ${profileDir}`)
      return
    }
    mkdirSync(profileDir, { recursive: true })
  }

  if (!existsSync(manifestPath)) {
    const bundles = profile === 'web'
      ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      : profile === 'headless'
        ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
        : ['@deepseek-ai/dsh-base']
    const manifest = {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }
    if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }

  const manifest = readJson(manifestPath)
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []

  const changedDeps = dependencies[pluginName] !== pluginVersion
  const changedBundles = !bundles.includes(pluginName)

  if (dryRun) {
    console.log(`[dry-run] profile: ${profile}`)
    console.log(`[dry-run] would copy plugin to: ${targetPackageDir}`)
    console.log(`[dry-run] would set dependency ${pluginName}: ${pluginVersion} (changed: ${changedDeps})`)
    console.log(`[dry-run] would append bundle ${pluginName} (changed: ${changedBundles})`)
    return
  }

  copyPlugin(targetPackageDir)

  if (changedDeps || changedBundles) {
    manifest.dependencies = { ...dependencies, [pluginName]: pluginVersion }
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: changedBundles ? [...bundles, pluginName] : bundles,
      },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }

  console.log(`installed ${pluginName} into profile ${profile}`)
  console.log(`package dir: ${targetPackageDir}`)
  console.log(`bundle layers: ${JSON.stringify(manifest.dsh.profile.bundles)}`)
  console.log('manual mode does not update pnpm-lock.yaml; run the official DSH/pnpm workflow before treating the profile as reconciled.')
  console.log('restart dsh web (or this profile) to load the plugin.')
}

const { profile, dryRun } = parseArgs(process.argv.slice(2))
install(profile, dryRun)
