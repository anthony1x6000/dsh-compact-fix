// ponytail: minimal code, stdlib, zero unnecessary dependencies.
/**
 * DeepSeek Harness Compaction Fix Plugin.
 *
 * Resolves [BUG] #8088: Compaction happens every few steps for no reason on
 * small/medium context models (e.g. 128k–150k context windows).
 *
 * In stock `@deepseek-ai/dsh-compaction-basic`, the compaction trigger formula is:
 *
 *   thresholdTokens = min(contextWindow * thresholdRatio,
 *                         contextWindow - reservedMaxTokens - headroomTokens)
 *
 * `headroomTokens` defaults to 65,536 and is an absolute value that does not scale
 * with context capacity. For a 150k route reserving 32k tokens, the second term
 * limits the message budget to 52,464 tokens (~35% of the window), completely
 * superseding the 80% threshold ratio (`thresholdRatio: 0.8`). Combined with tool
 * schemas and tool result pruning, this causes compaction to trigger every 1-2 steps.
 *
 * This plugin corrects `headroomTokens` (default: 8192) and `maxTokens` (default: 8192)
 * across:
 * 1. Cordis Agent Preset definitions (`standard`, `ptc`, `cordis`, etc.) via `agentPresets`
 * 2. Active and future `BasicCompactionEngine` instances and prototype methods
 * 3. Base composition layer via `cordis.patch.yml`
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
 * Recursively inspect and patch plugin row entries in a preset definition.
 * Returns the count of patched rows.
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

    // Traverse into nested groups (such as cordis:group "compaction")
    if (row.group === true && Array.isArray(row.config)) {
      patchedCount += patchPluginEntries(row.config, headroomTokens, maxTokens)
    }
  }

  return patchedCount
}

/**
 * Monkey-patches an existing BasicCompactionEngine class prototype
 * to enforce headroom and maxTokens budgets during compaction checks.
 */
export function patchEnginePrototype(
  engineClass: any,
  headroomTokens: number,
  maxTokens: number,
): boolean {
  if (!engineClass || typeof engineClass !== 'function' || !engineClass.prototype) {
    return false
  }
  const proto = engineClass.prototype
  if (proto.__compact_fix_patched) return false

  proto.__compact_fix_patched = true

  const origCompactIfNeeded = proto.compactIfNeeded
  if (typeof origCompactIfNeeded === 'function') {
    proto.compactIfNeeded = async function (agent: unknown, trigger: unknown, signal: unknown) {
      if (this.config && typeof this.config === 'object') {
        const currentHeadroom = this.config.headroomTokens ?? STOCK_HEADROOM_THRESHOLD
        if (currentHeadroom > headroomTokens) {
          this.config = {
            ...this.config,
            headroomTokens,
            maxTokens:
              this.config.maxTokens === undefined || this.config.maxTokens >= STOCK_HEADROOM_THRESHOLD
                ? maxTokens
                : Math.min(this.config.maxTokens, maxTokens),
          }
        }
      }
      return origCompactIfNeeded.call(this, agent, trigger, signal)
    }
  }

  const origSummarize = proto.summarize
  if (typeof origSummarize === 'function') {
    proto.summarize = async function (input: unknown, agent: unknown, signal: unknown) {
      if (this.config && typeof this.config === 'object') {
        const currentHeadroom = this.config.headroomTokens ?? STOCK_HEADROOM_THRESHOLD
        if (currentHeadroom > headroomTokens) {
          this.config = {
            ...this.config,
            headroomTokens,
            maxTokens:
              this.config.maxTokens === undefined || this.config.maxTokens >= STOCK_HEADROOM_THRESHOLD
                ? maxTokens
                : Math.min(this.config.maxTokens, maxTokens),
          }
        }
      }
      return origSummarize.call(this, input, agent, signal)
    }
  }

  return true
}

/**
 * Patch the agentPresets registry service:
 * 1. Walks all currently registered preset definitions.
 * 2. Wraps `agentPresets.register()` to intercept any presets registered later.
 */
export function patchPresetRegistry(
  agentPresets: any,
  headroomTokens: number,
  maxTokens: number,
): number {
  if (!agentPresets || typeof agentPresets !== 'object') return 0
  let totalPatched = 0

  // 1. Patch already registered definitions in agentPresets.definitions
  if (agentPresets.definitions && typeof agentPresets.definitions.values === 'function') {
    for (const record of agentPresets.definitions.values()) {
      if (record?.config?.plugins && Array.isArray(record.config.plugins)) {
        totalPatched += patchPluginEntries(record.config.plugins, headroomTokens, maxTokens)
      }
    }
  }

  // 2. Wrap register method to catch newly registering presets
  const origRegister = agentPresets.register
  if (typeof origRegister === 'function' && !agentPresets.__compact_fix_registered) {
    agentPresets.__compact_fix_registered = true
    agentPresets.register = function (definition: any) {
      if (definition?.plugins && Array.isArray(definition.plugins)) {
        patchPluginEntries(definition.plugins, headroomTokens, maxTokens)
      }
      return origRegister.call(this, definition)
    }
  }

  return totalPatched
}

/**
 * Inspect Cordis registry and runtime for any loaded BasicCompactionEngine classes or instances.
 */
export function scanAndPatchRegistry(
  ctx: any,
  headroomTokens: number,
  maxTokens: number,
): void {
  try {
    if (ctx.registry && typeof ctx.registry.entries === 'function') {
      for (const [plugin, entry] of ctx.registry.entries()) {
        if (
          plugin?.name === 'BasicCompactionEngine' ||
          entry?.name === COMPACTION_PLUGIN_NAME ||
          entry?.id?.endsWith(COMPACTION_PLUGIN_ID)
        ) {
          patchEnginePrototype(plugin, headroomTokens, maxTokens)
          if (entry?.fiber?.target?.config) {
            entry.fiber.target.config = {
              ...entry.fiber.target.config,
              headroomTokens,
              maxTokens,
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal inspection
  }
}

/**
 * Main Cordis plugin apply function.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const options = resolveOptions(config)
  const { headroomTokens, maxTokens } = options

  // Attempt dynamic import of BasicCompactionEngine to patch its prototype immediately
  import('@deepseek-ai/dsh-compaction-basic' as string)
    .then((mod: any) => {
      const engineClass = mod?.BasicCompactionEngine || mod?.default
      if (engineClass) {
        patchEnginePrototype(engineClass, headroomTokens, maxTokens)
      }
    })
    .catch(() => {
      // Package will be resolved from runtime registry or preset hooks
    })

  // Hook preset registry if already available
  const existingAgentPresets = (ctx as any).agentPresets || ctx.get('agentPresets')
  if (existingAgentPresets) {
    patchPresetRegistry(existingAgentPresets, headroomTokens, maxTokens)
  }

  // Also listen via inject for when agentPresets activates
  ctx.inject(['agentPresets'], (sessionCtx: any) => {
    const ap = sessionCtx.agentPresets || sessionCtx.get('agentPresets')
    if (ap) {
      patchPresetRegistry(ap, headroomTokens, maxTokens)
    }
  })

  // Scan registry on startup and on plugin add
  scanAndPatchRegistry(ctx, headroomTokens, maxTokens)
  ctx.on('internal/plugin' as any, () => {
    scanAndPatchRegistry(ctx, headroomTokens, maxTokens)
  })
}
