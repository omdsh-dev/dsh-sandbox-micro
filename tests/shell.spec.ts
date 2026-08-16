import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { MicrosandboxBackend } from '../src/backend.ts'
import { buildShellConfinement, MicrosandboxShellExecutor } from '../src/shell.ts'

function shellBackend() {
  return new MicrosandboxBackend({ image: 'debian' }, {
    resolveInvocation: () => ['node', 'fake-msb.cjs'],
    probe: () => true,
  })
}


describe('microsandbox shell executor: registration', () => {
  class FakeSubprocess extends Service {
    constructor(ctx: Context) {
      super(ctx, 'subprocess')
    }
  }

  class FakePolicy extends Service {
    readonly defaultMode: SandboxMode = 'workspace-write'
    readonly workspaceRoot = 'C:/workspace'
    constructor(ctx: Context) {
      super(ctx, 'sandboxPolicy')
    }
    resolve(): SandboxExecutionPolicy {
      return { mode: this.defaultMode, workspaceRoot: this.workspaceRoot }
    }
  }

  it('loads as ctx.shell when subprocess and sandboxPolicy are present', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(FakePolicy)
    await ctx.plugin(MicrosandboxShellExecutor, {
      image: 'debian',
      memory: '512M',
    } as ConstructorParameters<typeof MicrosandboxShellExecutor>[1])
    expect(ctx.get('shell')).toBeInstanceOf(MicrosandboxShellExecutor)
    expect(ctx.shell.sandboxMode).toBe('workspace-write')
  })
})

describe('microsandbox shell executor: confinement facts', () => {
  it('registers under the shell service and requires the policy service', () => {
    expect(MicrosandboxShellExecutor.inject).toEqual(['subprocess', 'sandboxPolicy'])
  })

  it('maps the resolved host workdir into the mounted guest workspace', () => {
    const out = buildShellConfinement(
      { command: 'pwd', workdir: 'C:/workspace/sub' },
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
      'workspace-write',
      shellBackend(),
    )
    expect(out.argv).toContain('-w')
    expect(out.argv).toContain('/work/sub')
    expect(out.workdir).toBe('C:/workspace/sub')
  })

  it('forwards local terminal overrides and the trusted DSH snapshot', () => {
    const out = buildShellConfinement(
      {
        command: 'env',
        workdir: 'C:/workspace',
        env: { ORDINARY: '1' },
        dshEnv: { DSH_SESSION_ID: 's-1' } as Record<string, string>,
      },
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
      'workspace-write',
      shellBackend(),
    )
    const env = out.argv.filter(arg => arg.startsWith('-e')).length
    expect(env).toBeGreaterThan(0)
    expect(out.argv).toContain('NO_COLOR=1')
    expect(out.argv).toContain('TERM=dumb')
    expect(out.argv).toContain('ORDINARY=1')
    expect(out.argv).toContain('DSH_SESSION_ID=s-1')
    expect(out.argv.slice(-4)).toEqual(['--', 'bash', '-c', 'env'])
  })

  it('refuses a workdir outside the policy workspace', () => {
    expect(() => buildShellConfinement(
      { command: 'true', workdir: 'C:/other' },
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
      'workspace-write',
      shellBackend(),
    )).toThrow(/outside/)
  })
})
