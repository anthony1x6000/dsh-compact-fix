# dsh-compact-fix

[![ci](https://github.com/anthony1x6000/dsh-compact-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-compact-fix/actions/workflows/ci.yml)

DeepSeek Harness plugin that resolves premature compaction loops on small/medium context models ([Issue #8088](https://github.com/deepseek-ai/deepseek-harness/discussions/8088)).

## Problem

In stock `@deepseek-ai/dsh-compaction-basic` (0.1.7+ / 0.2.0-rc.1+), the compaction trigger formula is:

```text
thresholdTokens = min(contextWindow * thresholdRatio,
                      contextWindow - reservedMaxTokens - headroomTokens)
```

`headroomTokens` defaults to `65536` and does not scale with window capacity. On small and medium context windows (e.g. 128k–150k), the second term wins and caps the usable context at ~23%–35% regardless of `thresholdRatio: 0.8`:

| Window $W$ | Reserve $O$ | Stock Trigger | Effective Context % |
|:---:|:---:|:---:|:---:|
| 150,000 | 32,000 | $\min(120000, 150000 - 32000 - 65536) = 52,464$ | 35.0% |
| 126,976 | 32,000 | $\min(101580, 126976 - 32000 - 65536) = 29,440$ | 23.2% |
| 1,000,000 | 256,000 | $\min(800000, 1000000 - 256000 - 65536) = 678,464$ | 67.8% |

Because `@deepseek-ai/dsh-token-meter` includes tool schemas in the token count, active sessions hit the trigger after only 1–2 steps, leading to endless compaction loops. Furthermore, top-level profile `cordis.patch.yml` overrides cannot target `compaction-basic` because agent presets (`standard`, `ptc`, `cordis`) isolate compaction inside their own plugin groups.

## Solution

`dsh-compact-fix` provides a multi-layer fix:
1. **Agent Preset Interception**: Hooks into `agentPresets` to tune `headroomTokens: 8192` and `maxTokens: 8192` across preset definitions (`standard`, `ptc`, `cordis`, etc.).
2. **Engine Runtime Hook**: Patches `BasicCompactionEngine.prototype.compactIfNeeded` and `summarize` to scale headroom down dynamically, protecting active sessions and custom presets.
3. **Bundle Patch Layer**: Sets `headroomTokens: 8192` and `maxTokens: 8192` on the base composition row in `cordis.patch.yml`.

Result for a 150k route: $\min(120000, 150000 - 32000 - 8192) = 109,808$ tokens (~73% of maximum), restoring expected threshold behavior.

## Install

Install the bundle into your `web` profile:

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-compact-fix#main"
```

Or link directly for local development:

```sh
dsh plugin --profile web add link:/path/to/dsh-compact-fix
```

Verify that the layer is present:

```sh
dsh --profile web --dump-config | grep -B 1 -A 5 compact-fix
```

Then restart `dsh web` (or `systemctl restart dsh-web.service`).

## Configuration

| Env / Row Field | Default | Description |
|:---|:---:|:---|
| `DSH_COMPACT_HEADROOM_TOKENS` / `headroomTokens` | `8192` | Headroom tokens reserved for compaction |
| `DSH_COMPACT_MAX_TOKENS` / `maxTokens` | `8192` | Maximum completion tokens for compaction summary |

## Development

```sh
pnpm install
pnpm build
pnpm selfcheck
```

## License

MIT
