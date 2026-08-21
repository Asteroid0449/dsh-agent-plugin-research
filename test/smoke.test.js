import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, inject, name, __testing } from '../lib/index.js'

const priorDshHome = process.env.DSH_HOME
const roots = []

afterEach(() => {
  if (priorDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorDshHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-research-test-'))
  roots.push(root)
  return root
}

function collect(config = {}) {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => {} } },
  }
  apply(ctx, config)
  return registered
}

async function rejectedPayload(promise) {
  try {
    await promise
    assert.fail('expected tool execution to reject')
  } catch (error) {
    assert.equal(error.name, 'PluginResearchToolError')
    return JSON.parse(error.message)
  }
}

function createInstalledBundle(home, profileName = 'web', packageName = 'example-plugin', version = '1.0.0') {
  process.env.DSH_HOME = home
  const profile = join(home, 'profiles', profileName)
  const root = join(profile, 'node_modules', packageName)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: packageName, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { [packageName]: version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', packageName] } },
  }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), `${packageName}: ${version}\n`)
  return profile
}

test('plugin exports the cordis function-plugin contract', () => {
  assert.equal(name, 'dsh-agent-plugin-research')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers a fixed agent-only research and lifecycle-planning surface', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  const names = registered.map(definition => definition.name).sort()
  assert.deepEqual(names, [
    'plugin_research_activation_plan',
    'plugin_research_inspect',
    'plugin_research_install',
    'plugin_research_list_installed',
    'plugin_research_search',
    'plugin_research_uninstall',
    'plugin_research_verify',
  ])
})

test('tool schemas stay identical regardless of optional lifecycle tools', () => {
  const collect = available => {
    const registered = []
    const ctx = {
      tools: {
        register(definition) { registered.push(definition); return () => {} },
        get(name) { return available.has(name) ? { name } : undefined },
      },
    }
    apply(ctx)
    return registered.map(({ name, description, parameters }) => ({ name, description, parameters }))
  }
  assert.deepEqual(collect(new Set()), collect(new Set(['dev_inject_plugin', 'dsh_restart'])))
})

test('curated search works without network', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  const search = registered.find(definition => definition.name === 'plugin_research_search')
  assert.ok(search)
  const result = await search.execute({ query: 'vision', source: 'curated' }, { signal: new AbortController().signal })
  assert.equal(typeof result, 'string')
  const parsed = JSON.parse(result)
  assert.equal(parsed.source, 'curated')
  assert.ok(parsed.items.length >= 2)
})

test('GitHub authentication is environment-based and remote failures reject the tool call', async () => {
  const priorFetch = globalThis.fetch
  const priorToken = process.env.TEST_PLUGIN_GITHUB_TOKEN
  try {
    let authorization
    process.env.TEST_PLUGIN_GITHUB_TOKEN = 'test-token'
    globalThis.fetch = async (_url, options) => {
      authorization = options.headers.authorization
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const search = collect({ githubTokenEnv: 'TEST_PLUGIN_GITHUB_TOKEN' }).find(tool => tool.name === 'plugin_research_search')
    const empty = JSON.parse(await search.execute({ query: 'none', source: 'github' }, { signal: new AbortController().signal }))
    assert.equal(empty.items.length, 0)
    assert.equal(authorization, 'Bearer test-token')

    globalThis.fetch = async () => new Response('', {
      status: 403,
      statusText: 'rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' },
    })
    const failure = await rejectedPayload(search.execute({ query: 'limited', source: 'github' }, { signal: new AbortController().signal }))
    assert.match(failure.error, /rate limit remaining=0/)
    assert.match(failure.error, /resets=/)
  } finally {
    globalThis.fetch = priorFetch
    if (priorToken === undefined) delete process.env.TEST_PLUGIN_GITHUB_TOKEN
    else process.env.TEST_PLUGIN_GITHUB_TOKEN = priorToken
  }
})

test('install refuses without confirm', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  const install = registered.find(definition => definition.name === 'plugin_research_install')
  assert.ok(install)
  const result = await install.execute({ spec: 'dsh-vision-router', profile: 'web', confirm: false })
  const parsed = JSON.parse(result)
  assert.equal(typeof parsed.error, 'string')
  assert.match(parsed.error, /confirm: true/)
})


test('verify tool reports an uninitialized profile without writing', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  const verify = registered.find(definition => definition.name === 'plugin_research_verify')
  assert.ok(verify)
  const result = await verify.execute({ package: 'dsh-agent-plugin-research', profile: '__does_not_exist__' })
  const parsed = JSON.parse(result)
  assert.equal(parsed.initialized, false)
})
test('plugin is agent-only and does not register web endpoints', () => {
  const routes = []
  const ctx = {
    tools: { register() { return () => {} } },
    inject(_deps, callback) {
      callback({ effect(fn) { fn() }, webServer: { register(route) { routes.push(route) } } })
    },
  }
  apply(ctx)
  assert.deepEqual(routes, [])
})

test('activation plan distinguishes super-injector, persistent patch-HMR, and supervised restart', async () => {
  createInstalledBundle(temporaryRoot())
  const registered = []
  const available = new Set([
    'dev_inject_plugin', 'dev_uninject_plugin', 'dev_install_package',
    'dev_reload_package', 'dev_plugin_status',
    'dsh_restart', 'dsh_restart_status', 'dsh_restart_cancel',
  ])
  const ctx = {
    tools: {
      register(definition) { registered.push(definition); return () => {} },
      get(name) { return available.has(name) ? { name } : undefined },
    },
  }
  apply(ctx)
  const plan = registered.find(definition => definition.name === 'plugin_research_activation_plan')
  const development = JSON.parse(await plan.execute(
    { package: 'example-plugin', change: 'reload', mode: 'auto' },
    { agent: { id: 'agent-1' } },
  ))
  assert.equal(development.selectedMode, 'development')
  assert.equal(development.capabilities.superInjector.completeDevelopmentLifecycle, true)
  assert.match(development.cautions.join(' '), /does not download or install/)

  const patch = JSON.parse(await plan.execute(
    { package: 'example-plugin', change: 'enable', mode: 'persistent-patch' },
    { agent: { id: 'agent-1' } },
  ))
  assert.equal(patch.selectedMode, 'persistent-patch')
  assert.match(patch.steps.join(' '), /cordis\.patch\.yml/)

  const restart = JSON.parse(await plan.execute(
    { package: 'example-plugin', change: 'install', mode: 'official-restart' },
    { agent: { id: 'agent-1' } },
  ))
  assert.equal(restart.selectedMode, 'official-restart')
  assert.match(restart.steps.join(' '), /dsh_restart/)
})

test('activation plan refuses to recommend restart before installation is consistent', async () => {
  process.env.DSH_HOME = temporaryRoot()
  const plan = collect().find(definition => definition.name === 'plugin_research_activation_plan')
  const result = JSON.parse(await plan.execute({ package: 'missing-plugin', profile: 'web', change: 'install' }, { agent: { id: 'agent-1' } }))
  assert.equal(result.ready, false)
  assert.equal(result.selectedMode, null)
  assert.match(result.steps.join(' '), /Install missing-plugin/)
})

test('install and uninstall specs reject command syntax and option-like values', () => {
  for (const value of ['pkg@1.0.0&whoami', 'pkg@1.0.0|x', 'pkg@1.0.0>x', 'pkg@1.0.0^x',
    'pkg@1.0.0%x', 'pkg@1.0.0!x', '"pkg@1.0.0"', 'pkg@1.0.0\n--global', '--global']) {
    assert.throws(() => __testing.validateInstallSpec(value), /forbidden|requires/)
  }
  assert.deepEqual(__testing.validateInstallSpec('@scope/plugin@1.2.3').packageName, '@scope/plugin')
  assert.equal(__testing.validateInstallSpec(`github:owner/repo#${'a'.repeat(40)}`).commit, 'a'.repeat(40))
  assert.throws(() => __testing.validatePackageName('github:owner/repo'))
  assert.throws(() => __testing.validatePackageName('--recursive'))
})

test('file specs are confined to explicitly allowed roots', () => {
  const allowed = temporaryRoot()
  const packageRoot = join(allowed, 'plugin')
  mkdirSync(packageRoot)
  assert.equal(__testing.validateInstallSpec(`file:${packageRoot}`, { allowedFileRoots: [allowed] }).kind, 'file')
  assert.throws(() => __testing.validateInstallSpec(`file:${temporaryRoot()}`, { allowedFileRoots: [allowed] }), /outside/)
})

test('semver compatibility honors upper bounds, caret, tilde, OR, prerelease, and invalid ranges', () => {
  const current = process.versions.node
  const currentMajor = Number(current.split('.')[0])
  const incompatibleMajor = currentMajor + 1
  assert.equal(__testing.nodeRangeOk(`=${current}`), true)
  assert.equal(__testing.nodeRangeOk(`>=${incompatibleMajor}.0 <${incompatibleMajor + 1}`), false)
  assert.equal(__testing.nodeRangeOk(`^${incompatibleMajor}.0.0`), false)
  assert.equal(__testing.nodeRangeOk(`~${incompatibleMajor}.0.0`), false)
  assert.equal(__testing.nodeRangeOk(`^${currentMajor} || ^${incompatibleMajor}`), true)
  assert.equal(__testing.nodeRangeOk(`>=${currentMajor}.0.0-rc.1 <${incompatibleMajor}`), true)
  assert.equal(__testing.nodeRangeOk('not-a-range'), null)
})

test('GitHub refs are parsed instead of discarded and package names are not guessed from source specs', () => {
  assert.deepEqual(__testing.parseGithubRepo('github:owner/repo#release/v1'), { owner: 'owner', repo: 'repo', ref: 'release/v1' })
  assert.deepEqual(__testing.parseGithubRepo('https://github.com/owner/repo/tree/feature%2Fsafe'), {
    owner: 'owner', repo: 'repo', ref: 'feature/safe',
  })
  assert.equal(__testing.packageNameFromSpec(`github:owner/repo#${'a'.repeat(40)}`), undefined)
  assert.equal(__testing.packageNameFromSpec('file:C:/plugin'), undefined)
})

test('unknown non-dependency bundle layers fail profile verification', () => {
  const home = temporaryRoot()
  process.env.DSH_HOME = home
  const profile = join(home, 'profiles', 'test')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'typo-plugin'] } },
  }))
  const report = __testing.verifyProfile('test')
  assert.equal(report.ok, false)
  assert.equal(report.layers[0].ok, true)
  assert.equal(report.layers[1].ok, false)
})

test('pnpm failure uses a shell-free substitute and never emits an activation plan', async () => {
  const home = temporaryRoot()
  process.env.DSH_HOME = home
  const fake = join(home, 'fake-pnpm.mjs')
  writeFileSync(fake, 'process.stderr.write("simulated failure\\n"); process.exit(17)\n')
  const install = collect({ pnpmCommand: process.execPath, pnpmCommandArgs: [fake] })
    .find(tool => tool.name === 'plugin_research_install')
  const result = await rejectedPayload(install.execute(
    { spec: 'safe-plugin@1.2.3', profile: 'test', confirm: true },
    { signal: new AbortController().signal },
  ))
  assert.equal(result.ok, false)
  assert.equal(result.pnpm.code, 17)
  assert.equal('activation' in result, false)
  assert.ok(result.residualState)
})

test('partial pnpm writes report blocked builds and exact recovery arguments', async () => {
  const home = temporaryRoot()
  process.env.DSH_HOME = home
  const fake = join(home, 'partial-pnpm.mjs')
  writeFileSync(fake, `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    manifest.dependencies = { ...(manifest.dependencies ?? {}), 'safe-plugin': '1.2.3' }
    writeFileSync('package.json', JSON.stringify(manifest, null, 2))
    const root = join('node_modules', 'safe-plugin')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'safe-plugin', version: '1.2.3' }))
    writeFileSync('pnpm-lock.yaml', 'safe-plugin: 1.2.3\\n')
    process.stderr.write('Ignored build scripts: node-pty@1.1.0\\n')
    process.exit(1)
  `)
  const install = collect({ pnpmCommand: process.execPath, pnpmCommandArgs: [fake] })
    .find(tool => tool.name === 'plugin_research_install')
  const result = await rejectedPayload(install.execute(
    { spec: 'safe-plugin@1.2.3', profile: 'test', confirm: true },
    { signal: new AbortController().signal },
  ))
  assert.equal(result.partial, true)
  assert.deepEqual(result.blockedBuilds, ['node-pty'])
  assert.deepEqual(result.recovery.retryArguments.allowBuildPackages, ['node-pty'])
  assert.equal('activation' in result, false)
})

test('cancelling the tool terminates an asynchronous pnpm substitute', async () => {
  const home = temporaryRoot()
  process.env.DSH_HOME = home
  const fake = join(home, 'slow-pnpm.mjs')
  writeFileSync(fake, 'setInterval(() => {}, 1000)\n')
  const install = collect({ pnpmCommand: process.execPath, pnpmCommandArgs: [fake], pnpmTimeoutMs: 10_000 })
    .find(tool => tool.name === 'plugin_research_install')
  const controller = new AbortController()
  const pending = install.execute(
    { spec: 'safe-plugin@1.2.3', profile: 'test', confirm: true }, { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 50)
  const result = await rejectedPayload(pending)
  assert.equal(result.ok, false)
  assert.match(result.pnpm.error, /cancelled/)
})

test('activation is emitted only when installed identity, lockfile, patch, and profile agree', async () => {
  const home = temporaryRoot()
  process.env.DSH_HOME = home
  const fake = join(home, 'identity-pnpm.mjs')
  writeFileSync(fake, `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const installedVersion = process.argv[2]
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    manifest.dependencies = { ...(manifest.dependencies ?? {}), 'safe-plugin': '1.2.3' }
    writeFileSync('package.json', JSON.stringify(manifest, null, 2))
    const root = join('node_modules', 'safe-plugin')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'safe-plugin', version: installedVersion, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(root, 'cordis.patch.yml'), '[]\\n')
    writeFileSync('pnpm-lock.yaml', 'safe-plugin: ' + installedVersion + '\\n')
  `)
  const run = async (profile, installedVersion) => {
    const install = collect({ pnpmCommand: process.execPath, pnpmCommandArgs: [fake, installedVersion] })
      .find(tool => tool.name === 'plugin_research_install')
    const pending = install.execute(
      { spec: 'safe-plugin@1.2.3', profile, confirm: true }, { signal: new AbortController().signal },
    )
    return installedVersion === '1.2.3' ? JSON.parse(await pending) : rejectedPayload(pending)
  }
  const matching = await run('matching', '1.2.3')
  assert.equal(matching.ok, true)
  assert.ok(matching.activation)
  const mismatch = await run('mismatch', '9.9.9')
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.identityMatches, false)
  assert.equal('activation' in mismatch, false)
})

test('Windows pnpm discovery executes the JavaScript entrypoint instead of spawning pnpm.cmd', () => {
  const root = temporaryRoot()
  const cli = join(root, 'node_modules', 'pnpm', 'dist', 'pnpm.mjs')
  mkdirSync(join(root, 'node_modules', 'pnpm', 'dist'), { recursive: true })
  writeFileSync(cli, '')
  const invocation = __testing.resolvePnpmInvocation({}, 'win32', { PATH: root })
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.prefixArgs, [cli])
  assert.equal(invocation.source, 'windows-js-entrypoint')
})

test('blocked builds produce exact retry names and allowBuilds updates are scoped', () => {
  assert.deepEqual(__testing.blockedBuildPackages({ stderr: 'Ignored build scripts: node-pty@1.1.0, @scope/native@2.0.0' }), ['node-pty', '@scope/native'])
  const profile = temporaryRoot()
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n  node-pty: set this to true or false\n')
  const result = __testing.setAllowedBuildPackages(profile, ['node-pty', '@scope/native'])
  assert.equal(result.changed, true)
  const text = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(text, /node-pty: true/)
  assert.match(text, /"@scope\/native": true/)
})

test('location reporting distinguishes profile runtime entries from linked source workspaces', () => {
  const home = temporaryRoot()
  const source = join(home, 'source-plugin')
  mkdirSync(source)
  process.env.DSH_HOME = home
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'linked-plugin': `link:${source}` }, dsh: { profile: { bundles: [] } } }))
  const location = __testing.installationLocation('web', 'linked-plugin')
  assert.equal(location.dependencyKind, 'linked-workspace')
  assert.equal(location.sourceWorkspace, source)
  assert.match(location.contract, /content cache/)
})

test('manual installer reads the adjacent package version', () => {
  const home = temporaryRoot()
  const profile = join(home, 'profiles', 'manual')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../install-manually.mjs', import.meta.url)), '--profile', 'manual', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
  })
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.match(output, new RegExp(`dependency dsh-agent-plugin-research: ${version.replaceAll('.', '\\.')}`))
})
