# dsh-compact-fix

[![ci](https://github.com/anthony1x6000/dsh-compact-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-compact-fix/actions/workflows/ci.yml)

DeepSeek Harness plugin that stops premature compaction loops ([Issue #8088](https://github.com/deepseek-ai/deepseek-harness/discussions/8088)).

## Problem

`@deepseek-ai/dsh-compaction-basic` triggers automatic pressure compaction when the session's measured token count crosses:

```text
messageBudget  = contextWindow - reservedCompletionTokens
pressureBudget = messageBudget  - headroomTokens
threshold      = floor(min(contextWindow * thresholdRatio, pressureBudget))
retainTokens   = floor(messageBudget * retainRatio)
```

`reservedCompletionTokens` is the routed request's **output cap**, read from the session request header. `headroomTokens` defaults to `65536` and does not scale with window capacity. Whichever term is smaller decides the trigger, so the intended `thresholdRatio` of `0.8` is easily overridden.

Either term can collapse the trigger on its own:

| Route | Window | Reserved | Stock trigger | Effective |
|:---|---:|---:|---:|---:|
| `deepseek-v4.1-flash` | 1,048,576 | 943,718 | `min(838860, 1048576 − 943718 − 65536) = 39,322` | **3.8%** |
| `grok-4.7` | 500,000 | 450,000 | `500000 − 450000 − 65536 < 0` | **throws** |
| 150,000 | 32,000 | 32,000 | `min(120000, 150000 − 32000 − 65536) = 52,464` | 35.0% |

Because `@deepseek-ai/dsh-token-meter` counts tool schemas, a session can cross a 39k trigger after one or two steps. The retained tail (`retainRatio` of that small message budget) plus the fixed prompt and tool-schema overhead then lands back above the trigger, so compaction repeats several times inside a single turn.

Two further constraints shape the fix:

- Top-level profile `cordis.patch.yml` overrides **cannot** reach `compaction-basic`. Agent presets (`standard`, `ptc`, `cordis`) isolate compaction inside their own `cordis:group`, so the top-level row is a different, disabled instance.
- When `pressureBudget` is not positive, `resolveCompactSpec` throws `TargetPressureConfigError`. A reserved cap that large makes the trigger unreachable rather than merely early.

## Solution

`dsh-compact-fix` lowers `headroomTokens` (default `8192`) and the summarization `maxTokens` (default `8192`). It applies them through two layers, because the plugin loads before the services it targets:

1. **Preset definitions** — wraps `agentPresets.register`, so every preset's nested `cordis:group` `compaction-basic` row is patched as the preset registers, and walks already-registered definitions.
2. **Engine prototype** — wraps `compactIfNeeded` and `summarize`. Both read `this.config` on every call, so replacing that reference corrects engines built before the plugin loaded, including presets added later.

The engine class is discovered structurally from `ctx.registry` (any class exposing `compactIfNeeded`), not by importing `@deepseek-ai/dsh-compaction-basic`. That package is not a dependency of this plugin, so a bare `import()` cannot resolve it.

### Companion fix: model output caps

Lowering `headroomTokens` alone is not always enough, because `reservedCompletionTokens` can consume the whole window. Declare the output cap your gateway actually enforces on the model entries in your profile:

```yaml
- id: llm-pi-ai
  config:
    providers:
      your-provider:
        models:
          - id: deepseek-v4.1-flash
            contextWindow: 1048576
            maxTokens: 131072   # not 943718
```

With `reservedCompletionTokens` at `131072`, `deepseek-v4.1-flash` resolves to `min(838860, 1048576 − 131072 − 8192) = 838,860` — the intended 80%.

## Install

Install the bundle into your `web` profile:

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-compact-fix#main"
```

Or link directly for local development:

```sh
dsh plugin --profile web add link:/path/to/dsh-compact-fix
```

Then restart `dsh web` (or `systemctl restart dsh-web.service`).

Verify the layer is present and that the plugin activated:

```sh
dsh --profile web --dump-config | grep -B 1 -A 5 compact-fix
journalctl -u dsh-web.service --since "5 min ago" | grep "did not activate"
```

The second command prints nothing when every entry activated.

## Configuration

| Env / Row Field | Default | Description |
|:---|:---:|:---|
| `DSH_COMPACT_HEADROOM_TOKENS` / `headroomTokens` | `8192` | Headroom tokens reserved for the compaction trigger |
| `DSH_COMPACT_MAX_TOKENS` / `maxTokens` | `8192` | Maximum completion tokens for the compaction summary |

Row fields take precedence over the environment, which takes precedence over the defaults.

## Development

```sh
pnpm install
pnpm build
pnpm selfcheck
```

`selfcheck.ts` covers config resolution, nested-group traversal, prototype patching, registry discovery, and a regression test asserting that `apply()` never probes an undeclared service through the Cordis property proxy. The shipped `0.1.0` build did exactly that, and the resulting throw aborted `apply()` before any layer of the fix ran.

## License

MIT
