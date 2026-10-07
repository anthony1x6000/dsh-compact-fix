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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "compact-fix";
/** Default reduced headroom tokens for balanced compaction triggers. */
export declare const DEFAULT_HEADROOM_TOKENS = 8192;
/** Default summarization max tokens (matched to headroom). */
export declare const DEFAULT_MAX_TOKENS = 8192;
/** Stock DSH headroom threshold that triggers the fix. */
export declare const STOCK_HEADROOM_THRESHOLD = 65536;
/** Target plugin identity in preset definitions. */
export declare const COMPACTION_PLUGIN_NAME = "@deepseek-ai/dsh-compaction-basic";
export declare const COMPACTION_PLUGIN_ID = "compaction-basic";
/** Configuration options for the compaction fix. */
export interface Config {
    /**
     * Headroom tokens reserved for compaction trigger calculation.
     * Stock DSH defaults to 65536.
     * @default 8192
     */
    headroomTokens?: number;
    /**
     * Maximum completion tokens for the summarization model request.
     * @default 8192
     */
    maxTokens?: number;
}
/** Resolved configuration values. */
export interface ResolvedOptions {
    headroomTokens: number;
    maxTokens: number;
}
/**
 * Resolve configuration from plugin options, environment variables, or defaults.
 *
 * Precedence is row `config`, then the environment, then the built-in defaults.
 *
 * @param config - Plugin row configuration from `cordis.patch.yml`.
 * @returns The resolved headroom and summarization token budgets.
 */
export declare function resolveOptions(config?: Config): ResolvedOptions;
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
export declare function patchPluginEntries(entries: unknown[], headroomTokens: number, maxTokens: number): number;
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
export declare function isCompactionEngine(value: unknown): boolean;
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
export declare function patchEnginePrototype(engineClass: unknown, headroomTokens: number, maxTokens: number): boolean;
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
export declare function patchPresetRegistry(agentPresets: unknown, headroomTokens: number, maxTokens: number): number;
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
export declare function scanAndPatchRegistry(ctx: Context, headroomTokens: number, maxTokens: number): number;
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
export declare function apply(ctx: Context, config?: Config): void;
