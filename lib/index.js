import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { satisfies, valid, validRange } from 'semver'

/**
 * dsh-agent-plugin-research
 *
 * A read-first community plugin market for DeepSeek Harness. The plugin
 * registers seven model-facing tools:
 *
 * - plugin_research_search        search GitHub topic:dsh-plugin / npm / curated list
 * - plugin_research_inspect       fetch package.json + cordis.patch.yml and flag risky patch shapes
 * - plugin_research_list_installed  list what is installed in one profile
 * - plugin_research_install       `pnpm add` a plugin into one profile (requires confirm:true)
 * - plugin_research_uninstall     `pnpm remove` a plugin from one profile (requires confirm:true)
 *
 * Permanent installs are ordinary profile-bundle installs. Activation is
 * delegated to rc8 patch-HMR, dsh-super-injector's dev_* lifecycle tools, or
 * dsh-restart-resume; this plugin does not duplicate those lifecycle engines.
 */

export const name = 'dsh-agent-plugin-research'
export const inject = ['tools']

const USER_AGENT = 'dsh-agent-plugin-research/0.5.0'
const MAX_PROCESS_OUTPUT = 32 * 1024
const MAX_REMOTE_BODY = 1024 * 1024
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const GITHUB_COMMIT = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9a-fA-F]{40})$/
const TOOL_ERROR = 'PluginResearchToolError'
const GITHUB_REPOSITORY_CACHE = new Map()

/** A small curated fallback so search still returns something useful offline. */
const CURATED_PLUGINS = [
  {
    source: 'curated',
    name: 'dsh-vision-router',
    repository: 'https://github.com/ysr666/dsh-vision-router',
    description: 'Vision tools and a free vision chain for text-only DeepSeek Harness agents.',
    installSpec: 'dsh-vision-router',
  },
  {
    source: 'curated',
    name: 'dsh-vision-proxy',
    repository: 'https://github.com/Flyvhidbwo/dsh-vision-proxy',
    description: 'Automatic image transcription route so text-only DeepSeek can read attached images.',
    installSpec: 'dsh-vision-proxy',
  },
  {
    source: 'curated',
    name: '@anionex/dsh-vision-toolkit',
    repository: 'https://github.com/Anionex/dsh-vision-toolkit',
    description: 'Agent-driven vision engineering toolkit for DeepSeek Harness.',
    installSpec: '@anionex/dsh-vision-toolkit',
  },
]

const PROFILE_TEMPLATE_BUNDLES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}
const KNOWN_INBOX_BUNDLES = new Set(Object.values(PROFILE_TEMPLATE_BUNDLES).flat())

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

export function apply(ctx, config) {
  const bind = definition => ({
    ...definition,
    execute(args, exec = {}) {
      return definition.execute(args, { ...exec, pluginContext: ctx, pluginConfig: config ?? {} })
    },
  })
  for (const definition of [
    searchTool,
    inspectTool,
    listInstalledTool,
    installTool,
    uninstallTool,
    verifyTool,
    activationPlanTool,
  ]) ctx.tools.register(bind(definition))
}

/** Tool: search plugins. */
const searchTool = {
  name: 'plugin_research_search',
  description: 'Search community dsh plugins. Sources: github (repositories with topic:dsh-plugin), npm (packages matching dsh keywords), and a small curated offline fallback. Returns JSON text with candidate plugins and install hints.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords, e.g. "vision", "terminal", or empty for the full dsh-plugin topic list.',
      },
      source: {
        type: 'string',
        enum: ['auto', 'github', 'npm', 'index', 'curated'],
        description: 'Where to search. auto tries github, then npm, then configured private indexes, then the curated fallback.',
      },
    },
    required: ['query'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    const query = typeof args.query === 'string' ? args.query : ''
    const source = typeof args.source === 'string' ? args.source : 'auto'
    const errors = []

    if (source === 'github') {
      try {
        const githubItems = await searchGithub(query, exec.signal, exec.pluginConfig)
        if (githubItems.length > 0) return json({ source: 'github', query, items: githubItems })
        errors.push('github: no matching repositories')
          return json({ source: 'github', query, items: [], note: 'no matching repositories' })
        // explicit github branch returns above
        // unreachable: explicit branch returns above
      } catch (error) {
        rethrowToolError(error, { source: 'github', query, items: [] })
      }
    }

    if (source === 'npm') {
      try {
        const npmItems = await searchNpm(query, exec.signal)
        if (npmItems.length > 0) return json({ source: 'npm', query, items: npmItems })
        errors.push('npm: no matching packages')
          return json({ source: 'npm', query, items: [], note: 'no matching packages' })
        // explicit npm branch returns above
        // unreachable: explicit branch returns above
      } catch (error) {
        rethrowToolError(error, { source: 'npm', query, items: [] })
      }
    }

    if (source === 'curated') {
      return json({ source: 'curated', query, items: searchCurated(query) })
    }

      if (source === 'index') {
        return json({ source: 'index', query, items: await searchPrivateIndexes(query, exec.signal, exec.pluginConfig) })
      }

    // auto: github -> npm -> index -> curated, prefer a non-empty remote result.
    try {
      const autoGithubItems = await searchGithub(query, exec.signal, exec.pluginConfig)
        if (autoGithubItems.length > 0) return json({ source: 'github', query, items: autoGithubItems })
        errors.push('github: no matching repositories')
    } catch (error) {
      errors.push(`github: ${errorMessage(error)}`)
    }
    try {
      const autoNpmItems = await searchNpm(query, exec.signal)
        if (autoNpmItems.length > 0) return json({ source: 'npm', query, items: autoNpmItems })
        errors.push('npm: no matching packages')
    } catch (error) {
      errors.push(`npm: ${errorMessage(error)}`)
    }

      const autoIndexItems = await searchPrivateIndexes(query, exec.signal, exec.pluginConfig)
      if (autoIndexItems.length > 0) return json({ source: 'index', query, items: autoIndexItems })
    return json({ source: 'curated', query, items: searchCurated(query), errors })
  },
}

/** Tool: inspect one plugin package before installing. */
const inspectTool = {
  name: 'plugin_research_inspect',
  description: 'Fetch package.json and cordis.patch.yml for one plugin (npm package name or GitHub repo) and report what the patch would add, including risky shapes such as !!js expressions, isolate realms, group rows, and disabled rows. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      package: {
        type: 'string',
        description: 'npm package name (e.g. dsh-vision-router) or GitHub repo (e.g. ysr666/dsh-vision-router or a full github.com URL).',
      },
      source: {
        type: 'string',
        enum: ['auto', 'npm', 'github'],
        description: 'How to resolve `package`. auto treats github.com URLs and owner/repo as github, everything else as npm.',
      },
    },
    required: ['package'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    const pkg = typeof args.package === 'string' ? args.package.trim() : ''
    if (pkg === '') return json({ error: 'package is required' })
    const source = typeof args.source === 'string' ? args.source : 'auto'
    const github = source === 'github' || (source === 'auto' && isGithubSpec(pkg))

    try {
      const inspection = github
        ? await inspectGithub(pkg, exec.signal, exec.pluginConfig)
        : await inspectNpm(pkg, exec.signal)
      return json(inspection)
    } catch (error) {
      if (github && /rate limit/i.test(errorMessage(error))) {
        try {
          return json(await inspectGithubThroughNpm(pkg, exec.signal))
        } catch (fallbackError) {
          rethrowToolError(error, {
            package: pkg,
            source: 'github',
            fallback: `npm fallback also failed: ${errorMessage(fallbackError)}`,
          })
        }
      }
      rethrowToolError(error, { package: pkg, source: github ? 'github' : 'npm' })
    }
  },
}

/** Tool: list what is installed in one profile. */
const listInstalledTool = {
  name: 'plugin_research_list_installed',
  description: 'List plugins installed in one dsh profile (default: web). Shows the authoritative profile registration directory, each runtime node_modules entry, any linked source workspace, package metadata, and the ordered bundle layer list. A pnpm store is a cache and is never reported as the plugin source or activation directory.',
  parameters: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: 'Profile name. Defaults to web. Only names without slashes are accepted.',
      },
    },
    required: [],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
    try {
      return json(listInstalled(profile))
    } catch (error) {
      rethrowToolError(error, { profile })
    }
  },
}

/** Tool: permanently install a plugin into one profile. */
const installTool = {
  name: 'plugin_research_install',
  description: 'Permanently install a plugin into the selected DSH profile using pnpm add, then reconcile dsh.profile.bundles. The profile is the authoritative registration target; registry package stores are only caches, while link:/file: specs retain a separately reported source workspace. This changes package files but does not claim the bundle is active. If pnpm blocks transitive build scripts, the failure reports exact reviewed retry arguments using allowBuildPackages. Next use plugin_research_activation_plan. Requires confirm:true because third-party install scripts may run.',
  parameters: {
    type: 'object',
    properties: {
      spec: {
        type: 'string',
        description: 'npm package name, github:owner/repo, or another pnpm add spec.',
      },
      profile: {
        type: 'string',
        description: 'Target profile. Defaults to web (the profile you start with `dsh web`).',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be exactly true. This is a deliberate guard against accidental permanent installs.',
      },
      allowBuildPackages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional exact dependency package names whose pnpm build scripts are authorized for this profile, for example ["node-pty"]. Only these reviewed names are added to allowBuilds.',
      },
    },
    required: ['spec', 'confirm'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    const spec = typeof args.spec === 'string' ? args.spec.trim() : ''
    if (spec === '') return json({ error: 'spec is required' })
    const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
    if (args.confirm !== true) {
      return json({
        error: 'install requires confirm: true — re-run with confirm true if you intend to permanently install this package into the profile.',
        spec,
        profile,
      })
    }
      const denied = await approvalDenial(exec.pluginContext, exec, `install ${spec} into profile ${profile}`)
      if (denied !== undefined) {
        return json({ error: denied, spec, profile })
      }
    try {
      const normalized = validateInstallSpec(spec, exec.pluginConfig)
      const allowBuildPackages = validateBuildPackages(args.allowBuildPackages)
      const result = await installPlugin(profile, normalized, exec, allowBuildPackages)
      if (result.ok === true && result.verification?.ok === true) {
        result.activation = activationPlan(exec.pluginContext, exec, {
          package: result.package, profile, change: 'install',
        })
      }
      if (result.ok !== true) throw toolError(result)
      return json(result)
    } catch (error) {
      rethrowToolError(error, { spec, profile })
    }
  },
}

/** Tool: permanently uninstall a plugin from one profile. */
const uninstallTool = {
  name: 'plugin_research_uninstall',
  description: 'Permanently remove a plugin dependency from a dsh profile using pnpm remove, then reconcile dsh.profile.bundles. Use plugin_research_activation_plan first when hot uninject is desirable, and dsh_restart when official bundle removal needs a process reload. Requires confirm:true.',
  parameters: {
    type: 'object',
    properties: {
      package: {
        type: 'string',
        description: 'Installed package name to remove, e.g. dsh-vision-router.',
      },
      profile: {
        type: 'string',
        description: 'Target profile. Defaults to web.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be exactly true.',
      },
    },
    required: ['package', 'confirm'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    const pkg = typeof args.package === 'string' ? args.package.trim() : ''
    if (pkg === '') return json({ error: 'package is required' })
    const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
    if (args.confirm !== true) {
      return json({
        error: 'uninstall requires confirm: true — re-run with confirm true if you intend to permanently remove this package.',
        package: pkg,
        profile,
      })
    }
      const denied = await approvalDenial(exec.pluginContext, exec, `uninstall ${pkg} from profile ${profile}`)
      if (denied !== undefined) {
        return json({ error: denied, package: pkg, profile })
      }
    try {
      validatePackageName(pkg)
      const result = await uninstallPlugin(profile, pkg, exec)
      if (result.ok === true && result.verification?.ok === true) {
        result.activation = activationPlan(exec.pluginContext, exec, {
          package: pkg, profile, change: 'uninstall',
        })
      }
      if (result.ok !== true) throw toolError(result)
      return json(result)
    } catch (error) {
      rethrowToolError(error, { package: pkg, profile })
    }
  },
}

/** Tool: verify one installed plugin is present and active in the bundle layers. */
const verifyTool = {
  name: 'plugin_research_verify',
  description: 'Verify installation metadata: dependency registration, package identity, lockfile, bundle patch and ordered bundle layer. Also reports authoritative profile/runtime/source locations. This is read-only and explicitly does not claim runtime services, client loading, or native artifacts are working; verify those after activation.',
  parameters: {
    type: 'object',
    properties: {
      package: {
        type: 'string',
        description: 'Installed package name to verify, e.g. dsh-vision-router.',
      },
      profile: {
        type: 'string',
        description: 'Target profile. Defaults to web.',
      },
    },
    required: ['package'],
  },
  output: {
    schema: { type: 'string' },
    render: (args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    const pkg = typeof args.package === 'string' ? args.package.trim() : ''
    if (pkg === '') return json({ error: 'package is required' })
    const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
    try {
      return json(verifyInstalled(profile, pkg))
    } catch (error) {
      rethrowToolError(error, { package: pkg, profile })
    }
  },
}

/** Tool: choose, but do not execute, an rc8 activation lifecycle. */
const activationPlanTool = {
  name: 'plugin_research_activation_plan',
  description: 'Inspect the current agent tool scope and return a truthful rc8 activation plan. Distinguishes dsh-super-injector dev_* hot lifecycle, persistent transactional cordis.patch.yml HMR for already resolvable packages, and dsh_restart for official bundle loading. Read-only: it does not edit patch files, invoke another tool, or restart DSH.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      package: { type: 'string', description: 'Package name or development package spec.' },
      profile: { type: 'string', description: 'Target profile; defaults to web.' },
      change: {
        type: 'string',
        enum: ['install', 'uninstall', 'reload', 'enable', 'disable'],
        description: 'Lifecycle change that must become active.',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'development', 'persistent-patch', 'official-restart'],
        description: 'Preferred activation family. auto selects from the current tool capabilities.',
      },
    },
    required: ['package', 'change'],
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    const pkg = typeof args.package === 'string' ? args.package.trim() : ''
    if (pkg === '') return json({ error: 'package is required' })
    const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
    try {
      resolveProfileDir(profile)
      return json(activationPlan(exec.pluginContext, exec, {
        package: pkg,
        profile,
        change: args.change,
        mode: args.mode ?? 'auto',
      }))
    } catch (error) {
      rethrowToolError(error, { package: pkg, profile })
    }
  },
}

// ── helpers ──────────────────────────────────────────────────────────────────

function json(value) {
  return JSON.stringify(value, null, 2)
}

function toolError(payload) {
  const error = new Error(json(payload))
  error.name = TOOL_ERROR
  return error
}

function rethrowToolError(error, payload) {
  if (error?.name === TOOL_ERROR) throw error
  throw toolError({ ok: false, ...payload, error: errorMessage(error) })
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function packageNameFromSpec(spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const versionAt = slash < 0 ? -1 : spec.indexOf('@', slash)
    return versionAt < 0 ? spec : spec.slice(0, versionAt)
  }
  if (/^(github:|https?:|file:|git\+|\.\.?[\\/])/.test(spec)) return undefined
  const versionAt = spec.indexOf('@')
  return versionAt < 0 ? spec : spec.slice(0, versionAt)
}

function validatePackageName(value) {
  if (!NPM_NAME.test(value)) throw new Error('package must be a canonical npm package name')
  return value
}

function validateBuildPackages(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('allowBuildPackages must be an array')
  return [...new Set(value.map(item => validatePackageName(typeof item === 'string' ? item.trim() : '')))]
}

function splitExactNpmSpec(spec) {
  const separator = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.lastIndexOf('@')
  if (separator <= 0) return undefined
  const packageName = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (!NPM_NAME.test(packageName) || !EXACT_VERSION.test(version) || valid(version) === null) return undefined
  return { kind: 'npm', spec: `${packageName}@${version}`, packageName, version }
}

function insideRoot(path, root) {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

function validateInstallSpec(spec, config = {}) {
  if (/[&|<>^%!"'`\r\n\0]/.test(spec) || spec.startsWith('-')) {
    throw new Error('install spec contains forbidden shell/option characters')
  }
  const npm = splitExactNpmSpec(spec)
  if (npm) return npm
  const github = spec.match(GITHUB_COMMIT)
  if (github) return {
    kind: 'github', spec: `github:${github[1]}/${github[2]}#${github[3].toLowerCase()}`,
    owner: github[1], repo: github[2], commit: github[3].toLowerCase(),
  }
  if (spec.startsWith('file:')) {
    const candidate = resolve(spec.slice(5))
    const roots = Array.isArray(config.allowedFileRoots) ? config.allowedFileRoots.map(root => realpathSync(resolve(root))) : []
    if (roots.length === 0 || !existsSync(candidate)) throw new Error('file specs require an existing path under configured allowedFileRoots')
    const actual = realpathSync(candidate)
    if (!roots.some(root => insideRoot(actual, root))) throw new Error('file spec is outside configured allowedFileRoots')
    return { kind: 'file', spec: `file:${actual}`, path: actual }
  }
  throw new Error('install requires name@exactVersion, github:owner/repo#40-character-commit, or an allowed file: path')
}

function scopedToolAvailable(ctx, toolName, agent) {
  try {
    return typeof ctx?.tools?.get === 'function' && ctx.tools.get(toolName, agent) !== undefined
  } catch {
    return false
  }
}

function activationPlan(ctx, exec, request) {
  const superInjectorTools = [
    'dev_inject_plugin',
    'dev_uninject_plugin',
    'dev_install_package',
    'dev_reload_package',
    'dev_plugin_status',
  ]
  const restartTools = ['dsh_restart', 'dsh_restart_status', 'dsh_restart_cancel']
  const availableSuperInjectorTools = superInjectorTools.filter(toolName => scopedToolAvailable(ctx, toolName, exec?.agent))
  const availableRestartTools = restartTools.filter(toolName => scopedToolAvailable(ctx, toolName, exec?.agent))
  const hasDevelopmentLifecycle = ['dev_inject_plugin', 'dev_uninject_plugin', 'dev_reload_package']
    .every(toolName => availableSuperInjectorTools.includes(toolName))
  const patchPath = join(resolveProfileDir(request.profile), 'cordis.patch.yml')
  const verification = ['install', 'enable', 'reload'].includes(request.change)
    ? verifyInstalled(request.profile, request.package)
    : undefined
  const location = installationLocation(request.profile, request.package)
  if (verification !== undefined && !verification.ok) {
    return {
      ready: false,
      package: request.package,
      profile: request.profile,
      change: request.change,
      requestedMode: request.mode ?? 'auto',
      selectedMode: null,
      location,
      verification,
      steps: [
        `Install ${request.package} into profile ${request.profile} and reconcile its ordered bundle layer first.`,
        'Run plugin_research_verify; do not restart or patch-activate until installation verification succeeds.',
      ],
      cautions: ['Activation planning does not install packages and will not recommend a restart for an absent or inconsistent package.'],
    }
  }
  let selected = request.mode ?? 'auto'
  if (selected === 'auto') {
    selected = hasDevelopmentLifecycle && request.change === 'reload'
      ? 'development'
      : availableRestartTools.includes('dsh_restart')
        ? 'official-restart'
        : 'persistent-patch'
  }

  const cautions = [
    'Raw cordis.patch.yml HMR does not download or install a package; its name must already resolve in the profile.',
    'Patch-HMR is transactional and persistent across restart, but the exact insert/remove/config shape must be derived from the plugin patch and validated; do not guess it.',
    'dsh-super-injector dev_* tools use their own development loader lifecycle. They are not the same mechanism as rc8 user-patch HMR.',
    'A permanent profile bundle change is officially activated by a real process load; call dsh_restart only after the current work is durable and user-authorized.',
  ]
  let steps
  if (selected === 'development') {
    steps = hasDevelopmentLifecycle
      ? [
          `Call dev_plugin_status for ${request.package} when available.`,
          request.change === 'uninstall' || request.change === 'disable'
            ? `Call dev_uninject_plugin for ${request.package} before removing files.`
            : request.change === 'reload'
              ? `Call dev_reload_package for ${request.package}.`
              : `Use dev_install_package if needed, then dev_inject_plugin for ${request.package}.`,
          'Verify the injected plugin and its model-facing tools in the current agent scope.',
        ]
      : ['dsh-super-injector lifecycle tools are incomplete in this agent scope; choose persistent-patch or official-restart.']
  } else if (selected === 'persistent-patch') {
    steps = [
      `Confirm ${request.package} is already resolvable from profile ${request.profile}.`,
      `Inspect the package cordis.patch.yml and edit ${patchPath} with the minimal validated insert/remove/config patch.`,
      'Wait for rc8 transactional HMR; if composition fails, keep the last known-good tree and report the loader error.',
      'Verify the plugin/tool surface immediately and again after a later restart to prove persistence.',
    ]
  } else {
    steps = [
      `Verify ${request.package} and the ordered bundle layer list in profile ${request.profile}.`,
      availableRestartTools.includes('dsh_restart')
        ? `Call dsh_restart with a concrete reason as the final tool action; monitor with dsh_restart_status.`
        : 'No dsh_restart tool is visible in this agent scope; ask the user to restart through the supervised launcher.',
      'After relaunch, verify the installed package, bundle layer and expected tool/client surface.',
    ]
  }
  return {
    ready: true,
    package: request.package,
    profile: request.profile,
    change: request.change,
    requestedMode: request.mode ?? 'auto',
    selectedMode: selected,
    location,
    verification,
    capabilities: {
      superInjector: {
        package: 'dsh-super-injector',
        availableTools: availableSuperInjectorTools,
        completeDevelopmentLifecycle: hasDevelopmentLifecycle,
      },
      rc8PersistentPatchHmr: { available: true, patchPath },
      supervisedRestart: { availableTools: availableRestartTools },
    },
    steps,
    cautions,
  }
}

/** Ask the approval seam before a permanent write. Returns undefined when allowed, or a denial message. */
async function approvalDenial(ctx, exec, reason) {
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
  if (approval === undefined || typeof approval.request !== 'function') return undefined
  if (exec === undefined || exec.agent === undefined) return `approval is available but this tool call has no agent to route it through; denied: ${reason}`
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'plugin_research_write',
      callId: exec.callId,
      reason,
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return undefined
      case 'rejected': return `the user rejected: ${reason}`
      case 'cancelled': return `approval was cancelled: ${reason}`
      case 'unavailable': return `no approval channel is available; denied: ${reason}`
      default: return `unexpected approval outcome; denied: ${reason}`
    }
  } catch (error) {
    return `approval request failed; denied: ${reason} — ${errorMessage(error)}`
  }
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function resolveProfileDir(profile) {
  if (profile === '' || profile === '.' || profile === '..' || profile === 'node_modules'
    || profile.includes('/') || profile.includes('\\')) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
  return join(dshHome(), 'profiles', profile)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonQuiet(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readProfileManifest(profileDir) {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

function writeProfileManifest(profileDir, manifest) {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Hoisted-profile package lookup: node_modules/<name>/package.json. */
function packageDir(profileDir, packageName) {
  const direct = join(profileDir, 'node_modules', ...packageName.split('/'))
  return existsSync(join(direct, 'package.json')) ? direct : undefined
}

/** Whether an installed dependency declares `dsh.bundle.patch`. */
function exportsPatch(profileDir, packageName) {
  const dir = packageDir(profileDir, packageName)
  if (dir === undefined) return false
  const manifest = readJsonQuiet(join(dir, 'package.json'))
  return typeof manifest?.dsh?.bundle?.patch === 'string'
}

function validBundlePatch(packageRoot, patch) {
  if (typeof patch !== 'string' || patch.trim() === '' || isAbsolute(patch)) return false
  const target = resolve(packageRoot, patch)
  return insideRoot(target, resolve(packageRoot)) && existsSync(target)
}

function lockfileHas(profileDir, packageName, version) {
  const path = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  return text.includes(packageName) && (version === undefined || version === null || text.includes(String(version)))
}

function stateSnapshot(profile, packageName) {
  const dir = resolveProfileDir(profile)
  const manifest = existsSync(join(dir, 'package.json')) ? readProfileManifest(dir) : undefined
  const found = packageName ? packageDir(dir, packageName) : undefined
  return {
    manifestDependency: packageName ? manifest?.dependencies?.[packageName] ?? null : null,
    inLockfile: packageName ? lockfileHas(dir, packageName) : existsSync(join(dir, 'pnpm-lock.yaml')),
    inNodeModules: found !== undefined,
    inBundleLayers: packageName ? (manifest?.dsh?.profile?.bundles ?? []).includes(packageName) : false,
    location: packageName ? installationLocation(profile, packageName) : profileLocation(profile),
  }
}

function dependencyKind(spec) {
  if (typeof spec !== 'string') return null
  if (spec.startsWith('link:')) return 'linked-workspace'
  if (spec.startsWith('file:')) return 'local-file'
  if (spec.startsWith('github:') || spec.startsWith('git+') || /github\.com/i.test(spec)) return 'git-package'
  return 'registry-package'
}

function sourcePathFromSpec(spec, profileDir) {
  if (typeof spec !== 'string' || (!spec.startsWith('link:') && !spec.startsWith('file:'))) return null
  const value = spec.slice(spec.indexOf(':') + 1)
  const candidate = isAbsolute(value) ? value : resolve(profileDir, value)
  try { return realpathSync(candidate) } catch { return candidate }
}

function profileLocation(profile) {
  const profileDir = resolveProfileDir(profile)
  return {
    profile,
    profileDir,
    registrationManifest: join(profileDir, 'package.json'),
    runtimeModulesDir: join(profileDir, 'node_modules'),
    contract: 'The DSH profile is the authoritative installation and bundle-registration target. The pnpm store is only a content cache, not a plugin source or activation directory.',
  }
}

function installationLocation(profile, packageName) {
  const base = profileLocation(profile)
  const manifest = existsSync(base.registrationManifest) ? readProfileManifest(base.profileDir) : undefined
  const spec = manifest?.dependencies?.[packageName] ?? null
  const entry = join(base.runtimeModulesDir, ...packageName.split('/'))
  let resolvedPackageRoot = null
  try { resolvedPackageRoot = realpathSync(entry) } catch {}
  return {
    ...base,
    package: packageName,
    dependencySpec: spec,
    dependencyKind: dependencyKind(spec),
    runtimeEntry: entry,
    resolvedPackageRoot,
    sourceWorkspace: sourcePathFromSpec(spec, base.profileDir),
  }
}

function ensureProfile(profile) {
  const dir = resolveProfileDir(profile)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'package.json'))) {
    const bundles = PROFILE_TEMPLATE_BUNDLES[profile] ?? ['@deepseek-ai/dsh-base']
    writeProfileManifest(dir, {
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    })
  }
  if (!existsSync(join(dir, 'cordis.patch.yml'))) {
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  }
  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
  }
  return dir
}

function sanitizeOutput(value) {
  const redacted = value
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
  return redacted.length <= MAX_PROCESS_OUTPUT
    ? redacted
    : `${redacted.slice(0, MAX_PROCESS_OUTPUT)}\n[output truncated]`
}

function resolvePnpmInvocation(config = {}, platform = process.platform, env = process.env) {
  if (typeof config.pnpmCommand === 'string' && config.pnpmCommand !== '') {
    return {
      command: config.pnpmCommand,
      prefixArgs: Array.isArray(config.pnpmCommandArgs) ? config.pnpmCommandArgs : [],
      source: 'configured',
    }
  }
  if (platform !== 'win32') return { command: 'pnpm', prefixArgs: [], source: 'path' }
  const roots = [...new Set([
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    env.PNPM_HOME,
    env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
  ].filter(Boolean))]
  for (const root of roots) {
    for (const relativePath of [
      ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
      ['node_modules', 'pnpm', 'bin', 'pnpm.js'],
      ['node_modules', 'pnpm', 'bin', 'pnpm.mjs'],
      ['node_modules', 'pnpm', 'dist', 'pnpm.cjs'],
      ['node_modules', 'pnpm', 'dist', 'pnpm.mjs'],
    ]) {
      const cli = join(root, ...relativePath)
      if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli], source: 'windows-js-entrypoint' }
    }
  }
  throw new Error('pnpm JavaScript entrypoint was not found on PATH/PNPM_HOME; refusing to spawn pnpm.cmd with shell:false on Windows')
}

function runPnpm(dir, args, exec = {}) {
  const invocation = resolvePnpmInvocation(exec.pluginConfig)
  const { command, prefixArgs } = invocation
  const timeoutMs = Math.min(Math.max(exec.pluginConfig?.pnpmTimeoutMs ?? 180_000, 1_000), 600_000)
  return new Promise(resolveProcess => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let forcedError
    const child = spawn(command, [...prefixArgs, ...args], {
      cwd: dir,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const capture = (current, chunk) => current.length >= MAX_PROCESS_OUTPUT
      ? current
      : current + chunk.toString('utf8', 0, MAX_PROCESS_OUTPUT - current.length + 1)
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk) })
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      exec.signal?.removeEventListener('abort', abort)
      resolveProcess({ ...result, invocation: invocation.source, stdout: sanitizeOutput(stdout), stderr: sanitizeOutput(stderr) })
    }
    const stop = reason => {
      forcedError = reason
      if (!child.killed && child.kill()) return
      finish({ code: null, error: reason })
    }
    const abort = () => stop('pnpm operation cancelled')
    const timer = setTimeout(() => stop(`pnpm timed out after ${timeoutMs}ms`), timeoutMs)
    child.once('error', error => finish({ code: null, error: error.message }))
    child.once('close', code => finish(forcedError === undefined ? { code } : { code: null, error: forcedError }))
    if (exec.signal?.aborted) abort()
    else exec.signal?.addEventListener('abort', abort, { once: true })
  })
}

function setAllowedBuildPackages(profileDir, packageNames) {
  if (packageNames.length === 0) return { changed: false, packages: [] }
  const path = join(profileDir, 'pnpm-workspace.yaml')
  const initial = existsSync(path) ? readFileSync(path, 'utf8') : PROFILE_PNPM_WORKSPACE
  const lines = initial.replaceAll('\r\n', '\n').split('\n')
  let header = lines.findIndex(line => /^allowBuilds:\s*(?:#.*)?$/.test(line))
  if (header < 0) {
    while (lines.at(-1) === '') lines.pop()
    lines.push('', 'allowBuilds:')
    header = lines.length - 1
  }
  let end = header + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
  let changed = false
  for (const packageName of packageNames) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const key = packageName.startsWith('@') ? JSON.stringify(packageName) : packageName
    const existing = lines.findIndex((line, index) => index > header && index < end
      && new RegExp(`^\\s{2}(?:${escaped}|["']${escaped}["']):`).test(line))
    if (existing >= 0) {
      if (!/^\s{2}[^:]+:\s*true\s*(?:#.*)?$/.test(lines[existing])) {
        lines[existing] = `  ${key}: true`
        changed = true
      }
    } else {
      lines.splice(end, 0, `  ${key}: true`)
      end += 1
      changed = true
    }
  }
  if (changed) writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`)
  return { changed, packages: packageNames, path }
}

function blockedBuildPackages(pnpm) {
  const combined = `${pnpm.stdout ?? ''}\n${pnpm.stderr ?? ''}`
  const match = combined.match(/Ignored build scripts:\s*([^\r\n]+)/i)
  if (!match) return []
  return match[1].split(',').map(value => value.trim().replace(/[.;]$/, '')).map(value => {
    const versionAt = value.lastIndexOf('@')
    return versionAt > 0 ? value.slice(0, versionAt) : value
  }).filter(value => NPM_NAME.test(value))
}

/**
 * Reconcile `dsh.profile.bundles` against installed dependencies, mirroring the
 * `dsh plugin` CLI: a dependency whose package declares `dsh.bundle.patch` joins
 * the bundle list; a previously-dependency bundle that is gone or no longer
 * declares the patch leaves the list.
 */
function reconcileBundles(before, after, profileDir) {
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const deps = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  let changed = false

  for (const packageName of deps) {
    const isBundle = exportsPatch(profileDir, packageName)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    }
  }

  const depSet = new Set(deps)
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDeps.has(packageName) || depSet.has(packageName)
    const stillBundle = depSet.has(packageName) && exportsPatch(profileDir, packageName)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }

  if (!changed) return false
  after.dsh = {
    ...after.dsh,
    profile: {
      ...after.dsh?.profile,
      bundles: plugins,
    },
  }
  writeProfileManifest(profileDir, after)
  return true
}

function listInstalled(profile) {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    return { profile, profileDir: dir, initialized: false, bundles: [], dependencies: [] }
  }
  const manifest = readProfileManifest(dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const deps = Object.entries(manifest.dependencies ?? {})
  const dependencies = deps.map(([name, spec]) => {
    const dir = packageDir(resolveProfileDir(profile), name)
    const pkg = dir === undefined ? undefined : readJsonQuiet(join(dir, 'package.json'))
    return {
      name,
      spec,
      installedVersion: pkg?.version ?? null,
      bundlePatch: pkg?.dsh?.bundle?.patch ?? null,
      inBundleLayers: bundles.includes(name),
      location: installationLocation(profile, name),
    }
  })
  return {
    profile,
    profileDir: dir,
    initialized: true,
    bundles,
    dependencies,
    location: profileLocation(profile),
  }
}

function verifyInstalled(profile, packageName) {
  const dir = resolveProfileDir(profile)
  const report = {
    profile,
    profileDir: dir,
    package: packageName,
    initialized: false,
    installed: false,
    declaresBundlePatch: false,
    inBundleLayers: false,
    ok: false,
  }
  if (!existsSync(join(dir, 'package.json'))) {
    report.error = `profile ${profile} is not initialized`
    return report
  }
  report.initialized = true
  const manifest = readProfileManifest(dir)
  report.inDependencies = Object.hasOwn(manifest.dependencies ?? {}, packageName)
  const packageDirFound = packageDir(dir, packageName)
  report.installed = packageDirFound !== undefined
  if (packageDirFound !== undefined) {
    const pkg = readJsonQuiet(join(packageDirFound, 'package.json'))
    report.installedVersion = pkg?.version ?? null
    report.declaresBundlePatch = typeof pkg?.dsh?.bundle?.patch === 'string'
    report.bundlePatch = pkg?.dsh?.bundle?.patch ?? null
    report.bundlePatchExists = validBundlePatch(packageDirFound, pkg?.dsh?.bundle?.patch)
    report.packageNameMatches = pkg?.name === packageName
    report.inLockfile = lockfileHas(dir, packageName, pkg?.version)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  report.inBundleLayers = bundles.includes(packageName)
  report.bundles = bundles
  report.location = installationLocation(profile, packageName)
  report.ok = report.inDependencies && report.installed && report.packageNameMatches
    && report.declaresBundlePatch && report.bundlePatchExists && report.inBundleLayers && report.inLockfile
  report.installationVerified = report.ok
  report.runtimeVerified = false
  report.runtimeVerificationRequired = true
  report.verificationScope = 'profile registration, package identity, lockfile, bundle patch and ordered bundle layer only; runtime services, client loading and native artifacts require post-activation checks'
  return report
}

function verifyProfile(profile) {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    return { profile, profileDir: dir, initialized: false, ok: false }
  }
  const manifest = readProfileManifest(dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const deps = new Set(Object.keys(manifest.dependencies ?? {}))
  const layers = bundles.map(name => {
    if (!deps.has(name)) {
      const known = KNOWN_INBOX_BUNDLES.has(name)
      return {
        name, inDependencies: false, knownInBoxBundle: known,
        note: known ? 'known profile-template bundle supplied by DSH' : 'unknown non-dependency bundle layer',
        ok: known,
      }
    }
    const pkgDir = packageDir(dir, name)
    const pkg = pkgDir === undefined ? undefined : readJsonQuiet(join(pkgDir, 'package.json'))
    const declaresPatch = typeof pkg?.dsh?.bundle?.patch === 'string'
    const patchExists = pkgDir !== undefined && validBundlePatch(pkgDir, pkg?.dsh?.bundle?.patch)
    const inLockfile = lockfileHas(dir, name, pkg?.version)
    return {
      name,
      inDependencies: true,
      inNodeModules: pkgDir !== undefined,
      installedVersion: pkg?.version ?? null,
      declaresBundlePatch: declaresPatch,
      bundlePatchExists: patchExists,
      inLockfile,
      bundlePatch: pkg?.dsh?.bundle?.patch ?? null,
      ok: pkgDir !== undefined && pkg?.name === name && declaresPatch && patchExists && inLockfile,
    }
  })
  return {
    profile,
    profileDir: dir,
    initialized: true,
    layers,
    ok: layers.every(layer => layer.ok),
  }
}

async function installPlugin(profile, identity, exec, allowBuildPackages = []) {
  const dir = ensureProfile(profile)
  const buildPolicy = setAllowedBuildPackages(dir, allowBuildPackages)
  const before = readProfileManifest(dir)
  const beforeNames = new Set(Object.keys(before.dependencies ?? {}))
  const pnpm = await runPnpm(dir, ['add', '--', identity.spec], exec)
  if (pnpm.code !== 0) {
    const blockedBuilds = blockedBuildPackages(pnpm)
    const residualState = stateSnapshot(profile, identity.packageName)
    return {
      ok: false,
      profile,
      profileDir: dir,
      spec: identity.spec,
      pnpm,
      buildPolicy,
      blockedBuilds,
      partial: residualState.manifestDependency !== null || residualState.inNodeModules || residualState.inLockfile,
      residualState,
      recovery: blockedBuilds.length > 0 ? {
        action: 'Review the blocked dependencies, then re-run plugin_research_install with the same exact spec and only the approved package names in allowBuildPackages.',
        retryArguments: { spec: identity.spec, profile, confirm: true, allowBuildPackages: blockedBuilds },
      } : null,
    }
  }
  const after = readProfileManifest(dir)
  const changedNames = Object.keys(after.dependencies ?? {}).filter(packageName =>
    !beforeNames.has(packageName) || before.dependencies?.[packageName] !== after.dependencies?.[packageName])
  const installedName = identity.packageName ?? (changedNames.length === 1 ? changedNames[0] : undefined)
  if (installedName === undefined || !NPM_NAME.test(installedName)) {
    return { ok: false, profile, profileDir: dir, spec: identity.spec, pnpm, residualState: stateSnapshot(profile), error: 'could not determine one canonical installed package name' }
  }
  const reconciled = reconcileBundles(before, after, dir)
  const finalManifest = readProfileManifest(dir)
  const verification = verifyInstalled(profile, installedName)
  const installedRoot = packageDir(dir, installedName)
  const installedManifest = installedRoot === undefined ? undefined : readJsonQuiet(join(installedRoot, 'package.json'))
  const lockText = existsSync(join(dir, 'pnpm-lock.yaml')) ? readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8') : ''
  const identityMatches = identity.kind === 'npm'
    ? installedName === identity.packageName && installedManifest?.version === identity.version
    : identity.kind === 'github'
      ? lockText.toLowerCase().includes(identity.commit)
      : lockText.includes(identity.spec)
  const profileVerification = verifyProfile(profile)
  const ok = verification.ok && identityMatches && profileVerification.ok
  return {
    ok,
    profile,
    profileDir: dir,
    spec: identity.spec,
    package: installedName,
    requestedIdentity: identity,
    installedIdentity: { name: installedManifest?.name ?? null, version: installedManifest?.version ?? null },
    identityMatches,
    reconciled,
    bundles: finalManifest.dsh?.profile?.bundles ?? [],
    dependencies: Object.keys(finalManifest.dependencies ?? {}),
    pnpm,
    buildPolicy,
    location: installationLocation(profile, installedName),
    verification,
    profileVerification,
    activationRequired: ok,
    note: ok ? 'Package identity and profile consistency verified; choose an activation lifecycle with plugin_research_activation_plan.' : 'Installation changed files but final identity/profile verification failed; activation is blocked.',
    ...ok ? {} : { residualState: stateSnapshot(profile, installedName) },
  }
}

async function uninstallPlugin(profile, packageName, exec) {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    return { ok: false, profile, profileDir: dir, error: `profile ${profile} is not initialized` }
  }
  const before = readProfileManifest(dir)
  const pnpm = await runPnpm(dir, ['remove', '--', packageName], exec)
  if (pnpm.code !== 0) {
    return { ok: false, profile, profileDir: dir, package: packageName, pnpm, residualState: stateSnapshot(profile, packageName) }
  }
  const after = readProfileManifest(dir)
  const reconciled = reconcileBundles(before, after, dir)
  const finalManifest = readProfileManifest(dir)
  const residualState = stateSnapshot(profile, packageName)
  const verification = {
    ok: residualState.manifestDependency === null && !residualState.inLockfile
      && !residualState.inNodeModules && !residualState.inBundleLayers,
    ...residualState,
  }
  const profileVerification = verifyProfile(profile)
  verification.ok &&= profileVerification.ok
  return {
    ok: verification.ok,
    profile,
    profileDir: dir,
    package: packageName,
    reconciled,
    bundles: finalManifest.dsh?.profile?.bundles ?? [],
    dependencies: Object.keys(finalManifest.dependencies ?? {}),
    pnpm,
    verification,
    profileVerification,
    activationRequired: verification.ok,
    note: verification.ok ? 'Package removal consistency verified; choose an activation lifecycle with plugin_research_activation_plan.' : 'Removal left inconsistent state; activation is blocked.',
    ...verification.ok ? {} : { residualState },
  }
}

// ── remote sources ───────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...options.headers,
    },
  })
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0)
    const rate = remaining === null ? '' : `; rate limit remaining=${remaining}${reset > 0 ? `, resets=${new Date(reset * 1000).toISOString()}` : ''}`
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${rate}`)
  }
  return JSON.parse(await boundedResponseText(response, options.maximumBytes))
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/plain',
      ...options.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  return boundedResponseText(response, options.maximumBytes)
}

async function boundedResponseText(response, maximumBytes = MAX_REMOTE_BODY) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`remote response exceeds ${maximumBytes} bytes`)
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let length = 0
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new Error(`remote response exceeds ${maximumBytes} bytes`)
    }
    output += decoder.decode(value, { stream: true })
  }
  return output + decoder.decode()
}

function githubHeaders(config = {}) {
  const envName = typeof config.githubTokenEnv === 'string' && config.githubTokenEnv !== '' ? config.githubTokenEnv : 'GITHUB_TOKEN'
  const token = process.env[envName] ?? process.env.GH_TOKEN
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

async function searchGithub(query, signal, config = {}) {
  const q = query.trim() === '' ? 'topic:dsh-plugin' : `${query.trim()} topic:dsh-plugin`
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`
  const data = await fetchJson(url, { signal, headers: githubHeaders(config) })
  return (data.items ?? []).map(item => {
    if (item.full_name) GITHUB_REPOSITORY_CACHE.set(item.full_name.toLowerCase(), {
      defaultBranch: item.default_branch,
      cachedAt: Date.now(),
    })
    return {
      source: 'github',
      name: item.full_name ?? '',
      repository: item.html_url ?? '',
      description: item.description ?? '',
      stars: item.stargazers_count ?? 0,
      updatedAt: item.updated_at ?? '',
      inspectHint: `Use plugin_research_inspect with package "${item.full_name}" and source "github" to see its package name and patch.`,
    }
  })
}

async function searchNpm(query, signal) {
  const text = query.trim() === '' ? 'dsh-plugin' : query.trim()
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=10`
  const data = await fetchJson(url, { signal })
  return (data.objects ?? []).map(object => ({
    source: 'npm',
    name: object.package?.name ?? '',
    version: object.package?.version ?? '',
    description: object.package?.description ?? '',
    repository: object.package?.links?.repository ?? '',
    npm: object.package?.links?.npm ?? '',
    inspectHint: `Use plugin_research_inspect with package "${object.package?.name ?? ''}" and source "npm" to see its patch.`,
  }))
}

function searchCurated(query) {
  const q = query.trim().toLowerCase()
  return CURATED_PLUGINS.filter(plugin => {
    if (q === '') return true
    return `${plugin.name} ${plugin.description}`.toLowerCase().includes(q)
  })
}

async function searchPrivateIndexes(query, signal, config = {}) {
  const indexes = Array.isArray(config.indexes) ? config.indexes : []
  const results = []
  for (const index of indexes) {
    const source = `index:${index.name ?? index.url ?? 'unnamed'}`
    try {
      const data = await fetchJson(index.url, { signal })
      const items = Array.isArray(data?.plugins) ? data.plugins : Array.isArray(data) ? data : []
      const q = query.trim().toLowerCase()
      for (const item of items) {
        const name = item.name ?? ''
        const haystack = `${name} ${item.description ?? ''} ${item.repository ?? ''}`.toLowerCase()
        if (q !== '' && !haystack.includes(q)) continue
        results.push({
          source,
          name,
          description: item.description ?? '',
          repository: item.repository ?? '',
          installSpec: item.installSpec ?? name,
          homepage: item.homepage ?? '',
        })
      }
    } catch (error) {
      results.push({ source, error: errorMessage(error) })
    }
  }
  return results
}

function isGithubSpec(value) {
  if (value.includes('github.com/')) return true
  if (value.startsWith('github:')) return true
  return /^[^/\s]+\/[^/\s]+$/.test(value) && !value.startsWith('@')
}

function parseGithubRepo(value) {
  const match = value.match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:tree|commit)\/([^?#]+))?(?:[?#].*)?$/)
  if (match !== null) {
    return { owner: match[1], repo: match[2], ref: match[3] ? decodeURIComponent(match[3]) : undefined }
  }
  const withoutPrefix = value.startsWith('github:') ? value.slice('github:'.length) : value
  const [repoPart, hashRef] = withoutPrefix.split('#', 2)
  const parts = repoPart.split('/')
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, ''), ref: hashRef || undefined }
  }
  throw new Error(`cannot parse GitHub repo from ${JSON.stringify(value)}`)
}

async function inspectNpm(pkg, signal) {
  validatePackageName(pkg)
  const encoded = encodeURIComponent(pkg)
  const registryUrl = `https://registry.npmjs.org/${encoded}`
  const meta = await fetchJson(registryUrl, { signal })
  const version = meta['dist-tags']?.latest
  if (version === undefined) {
    throw new Error(`npm package ${pkg} has no latest version`)
  }
  if (valid(version) === null || meta.versions?.[version] === undefined) {
    throw new Error(`npm returned an invalid latest version for ${pkg}`)
  }
  const registryManifest = meta.versions[version]
  const unpkgBase = `https://unpkg.com/${pkg}@${version}`
  const manifest = registryManifest
  let patchText
  try {
    patchText = await fetchText(`${unpkgBase}/cordis.patch.yml`, { signal })
  } catch {
    patchText = undefined
  }
  return {
    source: 'npm',
    package: pkg,
    version,
    summary: summarizeManifest(manifest),
    patch: analyzePatch(patchText),
    installSpec: `${pkg}@${version}`,
    identity: {
      name: pkg,
      version,
      integrity: registryManifest.dist?.integrity ?? null,
      shasum: registryManifest.dist?.shasum ?? null,
      tarball: registryManifest.dist?.tarball ?? null,
    },
  }
}

async function fetchGithubRaw(owner, repo, commit, path, signal) {
  return fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`, { signal })
}

async function inspectGithub(value, signal, config = {}) {
  const { owner, repo, ref } = parseGithubRepo(value)
  const cached = GITHUB_REPOSITORY_CACHE.get(`${owner}/${repo}`.toLowerCase())
  const cachedDefaultBranch = cached && Date.now() - cached.cachedAt < 300_000 ? cached.defaultBranch : undefined
  const endpoint = ref
    ? `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${owner}/${repo}`
  const resolved = !ref && cachedDefaultBranch
    ? { default_branch: cachedDefaultBranch }
    : await fetchJson(endpoint, { signal, headers: githubHeaders(config) })
  const commit = ref ? resolved.sha : (await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(resolved.default_branch)}`,
    { signal, headers: githubHeaders(config) },
  )).sha
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('GitHub did not resolve the ref to an immutable commit')
  const manifestText = await fetchGithubRaw(owner, repo, commit, 'package.json', signal)
  const manifest = JSON.parse(manifestText)
  let patchText
  try {
    patchText = await fetchGithubRaw(owner, repo, commit, 'cordis.patch.yml', signal)
  } catch {
    patchText = undefined
  }
  return {
    source: 'github',
    package: `${owner}/${repo}`,
    repository: `https://github.com/${owner}/${repo}`,
    version: manifest.version ?? '',
    summary: summarizeManifest(manifest),
    patch: analyzePatch(patchText),
    ref: ref ?? resolved.default_branch,
    commit: commit.toLowerCase(),
    installSpec: `github:${owner}/${repo}#${commit.toLowerCase()}`,
    identity: { name: manifest.name ?? null, commit: commit.toLowerCase(), repository: `${owner}/${repo}` },
  }
}

async function inspectGithubThroughNpm(value, signal) {
  const { owner, repo, ref } = parseGithubRepo(value)
  const manifest = JSON.parse(await fetchGithubRaw(owner, repo, ref ?? 'HEAD', 'package.json', signal))
  if (!NPM_NAME.test(manifest.name ?? '')) throw new Error('GitHub rate-limit fallback could not determine a canonical npm package name')
  const inspection = await inspectNpm(manifest.name, signal)
  return {
    ...inspection,
    fallback: {
      reason: 'GitHub API rate limit',
      requestedRepository: `${owner}/${repo}`,
      requestedRef: ref ?? null,
      note: 'Inspection continued through the package name declared by the repository. npm identity is authoritative for the returned installSpec.',
    },
  }
}

function compatibilityOf(engines) {
  const requiredNode = engines?.node
  const nodeOk = nodeRangeOk(requiredNode)
  return {
    currentNode: process.version,
    requiredNode: requiredNode ?? null,
    nodeOk,
    requiredDsh: engines?.dsh ?? null,
  }
}

function nodeRangeOk(range) {
  if (range === undefined) return true
  if (typeof range !== 'string' || range.trim() === '' || validRange(range) === null) return null
  return satisfies(process.versions.node, range, { includePrerelease: true })
}

function summarizeManifest(manifest) {
  return {
    name: manifest.name ?? '',
    version: manifest.version ?? '',
    description: manifest.description ?? '',
    license: manifest.license ?? '',
    repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '',
    engines: manifest.engines ?? {},
      compatibility: compatibilityOf(manifest.engines ?? {}),
    hasDshBundle: typeof manifest.dsh?.bundle?.patch === 'string',
    dshBundlePatch: manifest.dsh?.bundle?.patch ?? null,
    hasDshClient: manifest.dsh?.client !== undefined,
    installScripts: Object.keys(manifest.scripts ?? {}).filter(script => /^(preinstall|install|postinstall|prepare)$/.test(script)),
  }
}

function analyzePatch(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { found: false, note: 'No cordis.patch.yml or it is empty.' }
  }
  const ids = [...text.matchAll(/^\s*-\s+id:\s*(.+)$/gm)].map(match => match[1].trim())
  const disabled = [...text.matchAll(/disabled:\s*(true|false)/gm)].filter(match => match[1] === 'true').length
  const notes = []
  if (/!!js/.test(text)) notes.push('Patch contains !!js expressions: it can run JavaScript when the config is loaded.')
  if (/group:\s*true/.test(text)) notes.push('Patch creates a Cordis group row.')
  if (/isolate:/.test(text)) notes.push('Patch uses an isolate realm (service scoping).')
  if (disabled > 0) notes.push(`${disabled} row(s) are disabled.`)
  return {
    found: true,
    entryCount: ids.length,
    entryIds: ids,
    disabledCount: disabled,
    hasJsExpression: /!!js/.test(text),
    hasGroup: /group:\s*true/.test(text),
    hasIsolate: /isolate:/.test(text),
    notes,
  }
}

export const __testing = Object.freeze({
  blockedBuildPackages,
  installationLocation,
  nodeRangeOk,
  packageNameFromSpec,
  parseGithubRepo,
  resolvePnpmInvocation,
  setAllowedBuildPackages,
  validateInstallSpec,
  validateBuildPackages,
  validatePackageName,
  verifyProfile,
})
