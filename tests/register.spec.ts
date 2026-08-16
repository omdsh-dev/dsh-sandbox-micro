import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MicrosandboxProvider, { type Config } from '../src/index.ts'

async function loadProvider(config: Partial<Config> = {}): Promise<MicrosandboxProvider> {
  const ctx = new Context()
  await ctx.plugin(MicrosandboxProvider, config as Config)
  const provider = ctx.get('sandbox') as unknown as MicrosandboxProvider
  provider.internals.resolveInvocation = () => ['node', 'fake-msb.cjs']
  provider.internals.probe = () => true
  return provider
}

describe('dsh-sandbox-micro: provider plugin contract', () => {
  it('registers the sandbox service on load', async () => {
    const ctx = new Context()
    await ctx.plugin(MicrosandboxProvider)
    expect(ctx.get('sandbox')).toBeInstanceOf(MicrosandboxProvider)
  })

  it('maps read-only policy to a read-only workspace mount with no network and no shell wrapper', async () => {
    const provider = await loadProvider({ image: 'debian' })
    const out = provider.confine(['bash', '-c', 'echo hi'], {
      mode: 'read-only',
      workspaceRoot: 'C:/workspace',
    })
    expect(out.argv[0]).toBe('node')
    expect(out.argv[1]).toBe('fake-msb.cjs')
    expect(out.argv).not.toContain('cmd')
    expect(out.argv).not.toContain('/c')
    expect(out.argv).toContain('run')
    expect(out.argv).toContain('--no-net')
    expect(out.argv).toContain('C:/workspace:/work:ro')
    expect(out.argv).toContain('-w')
    expect(out.argv.slice(-4)).toEqual(['--', 'bash', '-c', 'echo hi'])
    expect(out.enforcement).toBe('full')
    expect(out.denialSignatures.length).toBeGreaterThan(0)
    expect(out.runnerFailureRules.length).toBeGreaterThan(0)
  })

  it('maps workspace-write to a read-write workspace mount', async () => {
    const provider = await loadProvider({})
    const out = provider.confine(['bash', '-c', 'touch f'], {
      mode: 'workspace-write',
      workspaceRoot: 'C:/workspace',
    })
    expect(out.argv).toContain('C:/workspace:/work')
    expect(out.argv).not.toContain(':ro')
    expect(out.argv).toContain('--security')
    expect(out.argv).toContain('restricted')
  })

  it('throws SANDBOX_UNAVAILABLE when the probe fails', async () => {
    const provider = await loadProvider({})
    provider.internals.probe = () => false
    expect(() => provider.confine(['bash', '-c', 'hi'], {
      mode: 'workspace-write',
      workspaceRoot: 'C:/workspace',
    })).toThrow(/probe failed/)
  })
})
