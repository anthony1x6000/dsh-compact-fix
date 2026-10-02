// ponytail: minimal assertions, stdlib only, zero extra testing framework bloat.
// Run: `node --experimental-strip-types selfcheck.ts`

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPACTION_PLUGIN_ID,
  COMPACTION_PLUGIN_NAME,
  DEFAULT_HEADROOM_TOKENS,
  DEFAULT_MAX_TOKENS,
  name,
  patchEnginePrototype,
  patchPluginEntries,
  patchPresetRegistry,
  resolveOptions,
} from './index.ts'

// 1. Config resolution tests
{
  const def = resolveOptions({})
  assert.strictEqual(def.headroomTokens, DEFAULT_HEADROOM_TOKENS)
  assert.strictEqual(def.maxTokens, DEFAULT_MAX_TOKENS)

  const custom = resolveOptions({ headroomTokens: 4096, maxTokens: 2048 })
  assert.strictEqual(custom.headroomTokens, 4096)
  assert.strictEqual(custom.maxTokens, 2048)

  // Invalid values fall back to defaults
  const fallback = resolveOptions({ headroomTokens: -1, maxTokens: 0 })
  assert.strictEqual(fallback.headroomTokens, DEFAULT_HEADROOM_TOKENS)
  assert.strictEqual(fallback.maxTokens, DEFAULT_MAX_TOKENS)
}

// 2. patchPluginEntries tests (including nested groups)
{
  const samplePlugins = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ],
    },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  ]

  const patched = patchPluginEntries(samplePlugins, 8192, 8192)
  assert.strictEqual(patched, 1, 'must patch exactly 1 compaction-basic entry')

  const group = samplePlugins[1] as any
  const compactionBasic = group.config[0]
  assert.deepStrictEqual(compactionBasic.config, {
    headroomTokens: 8192,
    maxTokens: 8192,
  })

  // Top-level direct entry without group
  const flatPlugins = [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { existing: true } },
  ]
  const flatPatched = patchPluginEntries(flatPlugins, 8192, 8192)
  assert.strictEqual(flatPatched, 1)
  assert.deepStrictEqual(flatPlugins[0].config, {
    existing: true,
    headroomTokens: 8192,
    maxTokens: 8192,
  })
}

// 3. patchEnginePrototype tests
{
  class MockEngine {
    config: any
    constructor(config: any) {
      this.config = config
    }
    async compactIfNeeded(_agent: any, _trigger: any, _signal: any) {
      return this.config
    }
    async summarize(_input: any, _agent: any, _signal: any) {
      return this.config
    }
  }

  const res = patchEnginePrototype(MockEngine, 8192, 8192)
  assert.strictEqual(res, true, 'patchEnginePrototype should succeed on unpatched class')

  // Calling twice returns false (idempotent)
  assert.strictEqual(patchEnginePrototype(MockEngine, 8192, 8192), false)

  const instance = new MockEngine({ headroomTokens: 65536, maxTokens: 65536 })
  const result = await instance.compactIfNeeded({}, 'pressure', {})
  assert.strictEqual(result.headroomTokens, 8192, 'compactIfNeeded must scale headroomTokens down to 8192')
  assert.strictEqual(result.maxTokens, 8192, 'compactIfNeeded must scale maxTokens down to 8192')

  // Preserves explicit lower custom values
  const instance2 = new MockEngine({ headroomTokens: 4096, maxTokens: 4096 })
  const result2 = await instance2.compactIfNeeded({}, 'pressure', {})
  assert.strictEqual(result2.headroomTokens, 4096, 'compactIfNeeded must not overwrite lower custom headroom')
}

// 4. patchPresetRegistry tests
{
  const definitions = new Map()
  definitions.set('standard', {
    config: {
      id: 'standard',
      plugins: [
        {
          id: 'compaction',
          group: true,
          config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }],
        },
      ],
    },
  })

  let registerCalled = false
  const mockAgentPresets: any = {
    definitions,
    register: (def: any) => {
      registerCalled = true
      return def
    },
  }

  const count = patchPresetRegistry(mockAgentPresets, 8192, 8192)
  assert.strictEqual(count, 1, 'must patch existing definition')

  const stdPlugins = definitions.get('standard').config.plugins[0].config[0]
  assert.strictEqual(stdPlugins.config.headroomTokens, 8192)

  // Verify wrapped register()
  const newDef = {
    id: 'custom',
    plugins: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }],
  }
  mockAgentPresets.register(newDef)
  assert.strictEqual(registerCalled, true)
  assert.strictEqual((newDef.plugins[0] as any).config.headroomTokens, 8192)
}

// 5. Packaging and Manifest assertions
{
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
    name: string
    files: string[]
    dsh?: { bundle?: { patch?: string } }
  }

  assert.strictEqual(manifest.name, 'dsh-compact-fix', 'package name must match module row reference')
  const patchRel = manifest.dsh?.bundle?.patch
  assert(typeof patchRel === 'string' && patchRel.length > 0, 'package.json must declare dsh.bundle.patch')

  const patchPath = join(import.meta.dirname, patchRel)
  const patch = readFileSync(patchPath, 'utf8')

  for (const shipped of [patchRel.replace(/^\.\//u, ''), 'lib/index.js', 'lib/index.d.ts', 'README.md', 'LICENSE']) {
    assert(manifest.files.includes(shipped), `files in package.json must include ${shipped}`)
    assert.doesNotThrow(() => readFileSync(join(import.meta.dirname, shipped), 'utf8'), `${shipped} must exist`)
  }

  assert(patch.includes(`name: '${manifest.name}'`), 'bundle layer must reference the module by package name')
  assert(!patch.includes('./index.ts'), 'bundle layer must not reference source paths')
  assert(patch.includes('headroomTokens: 8192'), 'bundle layer must set headroomTokens: 8192')
  assert(patch.includes('maxTokens: 8192'), 'bundle layer must set maxTokens: 8192')

  // Import built artifact from lib/index.js
  const built = (await import('./lib/index.js')) as typeof import('./index.ts')
  assert.strictEqual(built.name, name, 'built artifact must export plugin name')
  assert.strictEqual(typeof built.apply, 'function', 'built artifact must export apply')
  assert.strictEqual(built.DEFAULT_HEADROOM_TOKENS, 8192)
  assert.strictEqual(built.DEFAULT_MAX_TOKENS, 8192)
}

console.log('dsh-compact-fix selfcheck: ok')
