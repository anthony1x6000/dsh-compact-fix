/**
 * DeepSeek Harness Compaction Fix Plugin.
 *
 * Resolves [BUG] #8088: compaction fires every one to three steps on
 * medium and large context routes.
 *
 * In `@deepseek-ai/dsh-compaction-basic` the automatic pressure trigger is:
 *
 *   messageBudget  = contextWindow - reservedCompletionTokens
 *   pressureBudget = messageBudget  - headroomTokens
 *   threshold      = floor(min(contextWindow * thresholdRatio, pressureBudget))
 *
 * `reservedCompletionTokens` is the routed request's own output cap, read from
 * the session request header. `headroomTokens` defaults to 65536 and does not
 * scale with window capacity. Whichever term is smaller decides the trigger, so
 * an inflated output cap or the stock headroom can hold the trigger far below
 * the intended `thresholdRatio` (0.8).
 *
 * This plugin lowers `headroomTokens` (default 8192) and the summarization
 * `maxTokens` (default 8192) on every live compaction engine:
 *
 * 1. Agent preset definitions via `agentPresets`, covering `standard`, `ptc`,
 *    `minimal`, `cordis`, and presets registered later.
 * 2. `compactIfNeeded` / `summarize` on the engine prototype, which reads
 *    `this.config` on every call, so engines built before this plugin loaded
 *    are corrected too.
 * 3. The base composition row via `cordis.patch.yml`.
 *
 * @module dsh-compact-fix
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compact-fix'

/** Default reduced headroom tokens for balanced compaction triggers. */
export const DEFAULT_HEADROOM_TOKENS = 8192

/** Default summarization max tokens (matched to headroom). */
export const DEFAULT_MAX_TOKENS = 8192

/** Stock DSH headroom threshold that triggers the fix. */
export const STOCK_HEADROOM_THRESHOLD = 65536

/** Target plugin identity in preset definitions. */
export const COMPACTION_PLUGIN_NAME = '@deepseek-ai/dsh-compaction-basic'
export const COMPACTION_PLUGIN_ID = 'compaction-basic'

/** Configuration options for the compaction fix. */
export interface Config {
  /**
   * Headroom tokens reserved for compaction trigger calculation.
   * Stock DSH defaults to 65536.
   * @default 8192
   */
  headroomTokens?: number

  /**
   * Maximum completion tokens for the summarization model request.
   * @default 8192
   */
  maxTokens?: number
}

/** Resolved configuration values. */
export interface ResolvedOptions {
  headroomTokens: number
  maxTokens: number
}

/**
 * Resolve configuration from plugin options, environment variables, or defaults.
 *
 * Precedence is row `config`, then the environment, then the built-in defaults.
 *
 * @param config - Plugin row configuration from `cordis.patch.yml`.
 * @returns The resolved headroom and summarization token budgets.
 */
export function resolveOptions(config: Config = {}): ResolvedOptions {
  const envHeadroom = process.env.DSH_COMPACT_HEADROOM_TOKENS
    ? Number(process.env.DSH_COMPACT_HEADROOM_TOKENS)
    : undefined
  const envMaxTokens = process.env.DSH_COMPACT_MAX_TOKENS
    ? Number(process.env.DSH_COMPACT_MAX_TOKENS)
    : undefined

  const headroomTokens =
    typeof config.headroomTokens === 'number' && config.headroomTokens > 0
      ? config.headroomTokens
      : typeof envHeadroom === 'number' && Number.isFinite(envHeadroom) && envHeadroom > 0
        ? envHeadroom
        : DEFAULT_HEADROOM_TOKENS

  const maxTokens =
    typeof config.maxTokens === 'number' && config.maxTokens > 0
      ? config.maxTokens
      : typeof envMaxTokens === 'number' && Number.isFinite(envMaxTokens) && envMaxTokens > 0
        ? envMaxTokens
        : Math.min(headroomTokens, DEFAULT_MAX_TOKENS)

  return { headroomTokens, maxTokens }
}

/**
 * Recursively patch `compaction-basic` rows in a preset plugin list.
 *
 * Agent presets declare compaction inside a nested `cordis:group` row whose
 * `config` holds the child plugin list, so the walk descends through every
 * `group: true` row before it finishes.
 *
 * @param entries - Plugin rows from a preset definition.
 * @param headroomTokens - Headroom tokens to write onto matching rows.
 * @param maxTokens - Summarization max tokens to write onto matching rows.
 * @returns The number of patched rows.
 */
export function patchPluginEntries(
  entries: unknown[],
  headroomTokens: number,
  maxTokens: number,
): number {
  if (!Array.isArray(entries)) return 0
  let patchedCount = 0

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as {
      id?: string
      name?: string
      group?: boolean
      config?: unknown
    }

    if (row.id === COMPACTION_PLUGIN_ID || row.name === COMPACTION_PLUGIN_NAME) {
      const existingConfig =
        typeof row.config === 'object' && row.config !== null ? (row.config as Record<string, unknown>) : {}
      row.config = {
        ...existingConfig,
        headroomTokens,
        maxTokens,
      }
      patchedCount++
    }

    // Traverse into nested groups (such as the `cordis:group` "compaction" row).
    if (row.group === true && Array.isArray(row.config)) {
      patchedCount += patchPluginEntries(row.config, headroomTokens, maxTokens)
    }
  }

  return patchedCount
}

/**
 * Decide whether a registry callback is a compaction engine class.
 *
 * The check is structural rather than name-based: the loader registers the
 * module's default export, so any class exposing `compactIfNeeded` on its
 * prototype is a compaction engine regardless of how it was named or wrapped.
 *
 * @param value - A registry key, expected to be a plugin callback or class.
 * @returns `true` when the value is a class with a `compactIfNeeded` method.
 */
export function isCompactionEngine(value: unknown): boolean {
  if (typeof value !== 'function') return false
  const proto = (value as { prototype?: unknown }).prototype
  if (proto === undefined || proto === null || typeof proto !== 'object') return false
  return typeof (proto as Record<string, unknown>).compactIfNeeded === 'function'
}

/**
 * Wrap an engine class so every call re-derives `this.config` from the plugin's
 * budgets. `compactIfNeeded` resolves its policy from `this.config` on each
 * call, so replacing the reference corrects engines that were constructed
 * before this plugin loaded.
 *
 * @param engineClass - The compaction engine class to patch.
 * @param headroomTokens - Headroom tokens to enforce.
 * @param maxTokens - Summarization max tokens to enforce.
 * @returns `true` when this call performed the patch, `false` when the class was
 *   unusable or already patched.
 */
export function patchEnginePrototype(
  engineClass: unknown,
  headroomTokens: number,
  maxTokens: number,
): boolean {
  if (!isCompactionEngine(engineClass)) return false
  const proto = (engineClass as { prototype: Record<string, unknown> }).prototype
  if (proto.__compact_fix_patched === true) return false

  proto.__compact_fix_patched = true

  const relax = function (this: { config?: Record<string, unknown> }): void {
    if (this.config === undefined || typeof this.config !== 'object') return
    const currentHeadroom = this.config.headroomTokens
    const headroom = typeof currentHeadroom === 'number' ? currentHeadroom : STOCK_HEADROOM_THRESHOLD
    if (headroom <= headroomTokens) return
    const currentMax = this.config.maxTokens
    this.config = {
      ...this.config,
      headroomTokens,
      maxTokens:
        typeof currentMax !== 'number' || currentMax >= STOCK_HEADROOM_THRESHOLD
          ? maxTokens
          : Math.min(currentMax, maxTokens),
    }
  }

  for (const method of ['compactIfNeeded', 'summarize'] as const) {
    const original = proto[method]
    if (typeof original !== 'function') continue
    proto[method] = function (this: { config?: Record<string, unknown> }, ...args: unknown[]) {
      relax.call(this)
      return (original as (...rest: unknown[]) => unknown).apply(this, args)
    }
  }

  return true
}

/**
 * Patch the agent preset registry service.
 *
 * Walks the preset definitions already registered, then wraps `register()` so
 * presets declared later are covered as well. Each record stores the parsed
 * preset configuration, whose plugin list lives at `config.plugins`.
 *
 * @param agentPresets - The `agentPresets` service.
 * @param headroomTokens - Headroom tokens to write onto matching rows.
 * @param maxTokens - Summarization max tokens to write onto matching rows.
 * @returns The number of patched rows across all registered presets.
 */
export function patchPresetRegistry(
  agentPresets: unknown,
  headroomTokens: number,
  maxTokens: number,
): number {
  if (!agentPresets || typeof agentPresets !== 'object') return 0
  const registry = agentPresets as {
    definitions?: { values?: () => Iterable<unknown> }
    register?: (...args: unknown[]) => unknown
    __compact_fix_registered?: boolean
  }
  let totalPatched = 0

  // 1. Patch definitions registered before this plugin loaded.
  if (typeof registry.definitions?.values === 'function') {
    for (const record of registry.definitions.values()) {
      const plugins = (record as { config?: { plugins?: unknown } })?.config?.plugins
      if (Array.isArray(plugins)) {
        totalPatched += patchPluginEntries(plugins, headroomTokens, maxTokens)
      }
    }
  }

  // 2. Wrap register() so presets declared later are covered too.
  const origRegister = registry.register
  if (typeof origRegister === 'function' && registry.__compact_fix_registered !== true) {
    registry.__compact_fix_registered = true
    registry.register = function (this: unknown, ...args: unknown[]) {
      const definition = args[0] as { plugins?: unknown } | undefined
      if (definition && Array.isArray(definition.plugins)) {
        patchPluginEntries(definition.plugins, headroomTokens, maxTokens)
      }
      return origRegister.apply(this, args)
    }
  }

  return totalPatched
}

/**
 * Find every registered compaction engine and patch its prototype.
 *
 * `ctx.registry` is the root-scoped plugin registry, so it also reaches the
 * engines that agent presets build inside their own isolated groups. The
 * compaction package is not a dependency of this plugin, which is why the
 * class is discovered here rather than imported by name.
 *
 * @param ctx - The plugin context.
 * @param headroomTokens - Headroom tokens to enforce.
 * @param maxTokens - Summarization max tokens to enforce.
 * @returns The number of engine classes patched by this call.
 */
export function scanAndPatchRegistry(
  ctx: Context,
  headroomTokens: number,
  maxTokens: number,
): number {
  const registry = (ctx as unknown as { registry?: { entries?: () => Iterable<[unknown, unknown]> } }).registry
  if (typeof registry?.entries !== 'function') return 0

  let patched = 0
  for (const [callback] of registry.entries()) {
    if (patchEnginePrototype(callback, headroomTokens, maxTokens)) patched++
  }
  return patched
}

/**
 * Main Cordis plugin apply function.
 *
 * Reads optional services through `ctx.get`. The `ctx.<name>` property proxy
 * throws for undeclared injections, so it cannot be used to probe for a service
 * that may not be present.
 *
 * @param ctx - The plugin context.
 * @param config - Plugin row configuration from `cordis.patch.yml`.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { headroomTokens, maxTokens } = resolveOptions(config)
  const getService = (serviceName: string): unknown =>
    (ctx as unknown as { get?: (service: string) => unknown }).get?.(serviceName)

  const patchPresets = (service: unknown): number =>
    patchPresetRegistry(service, headroomTokens, maxTokens)

  // Engines already built by the presets are reachable through the registry.
  const patchedEngines = scanAndPatchRegistry(ctx, headroomTokens, maxTokens)

  // Presets registered before this plugin loaded.
  const existingPresets = getService('agentPresets')
  const patchedRows = existingPresets === undefined ? 0 : patchPresets(existingPresets)

  ctx.logger.info(
    `compact-fix: headroomTokens=${headroomTokens} maxTokens=${maxTokens}; `
    + `patched ${patchedEngines} engine(s) and ${patchedRows} preset row(s)`,
  )

  // Presets declared after this plugin loaded.
  ctx.inject(['agentPresets'], (sessionCtx: Context) => {
    const service = (sessionCtx as unknown as { get?: (name: string) => unknown }).get?.('agentPresets')
    if (service !== undefined) patchPresets(service)
  })

  // Any plugin that registers later may add another compaction engine.
  ctx.on('internal/plugin', () => {
    scanAndPatchRegistry(ctx, headroomTokens, maxTokens)
  })
}
