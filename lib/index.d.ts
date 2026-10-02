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
 */
export declare function resolveOptions(config?: Config): ResolvedOptions;
/**
 * Recursively inspect and patch plugin row entries in a preset definition.
 * Returns the count of patched rows.
 */
export declare function patchPluginEntries(entries: unknown[], headroomTokens: number, maxTokens: number): number;
/**
 * Monkey-patches an existing BasicCompactionEngine class prototype
 * to enforce headroom and maxTokens budgets during compaction checks.
 */
export declare function patchEnginePrototype(engineClass: any, headroomTokens: number, maxTokens: number): boolean;
/**
 * Patch the agentPresets registry service:
 * 1. Walks all currently registered preset definitions.
 * 2. Wraps `agentPresets.register()` to intercept any presets registered later.
 */
export declare function patchPresetRegistry(agentPresets: any, headroomTokens: number, maxTokens: number): number;
/**
 * Inspect Cordis registry and runtime for any loaded BasicCompactionEngine classes or instances.
 */
export declare function scanAndPatchRegistry(ctx: any, headroomTokens: number, maxTokens: number): void;
/**
 * Main Cordis plugin apply function.
 */
export declare function apply(ctx: Context, config?: Config): void;
