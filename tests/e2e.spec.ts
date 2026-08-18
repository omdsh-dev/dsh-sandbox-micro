import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { MicrosandboxBackend } from '../src/backend.ts'
import { MicrosandboxShellExecutor, type Config } from '../src/shell.ts'

/**
 * Real microsandbox smoke tests. They boot a VM and are opt-in via
 * `npm run test:e2e` (or DSH_MICROSANDBOX_E2E=1) so ordinary CI runs stay
 * hermetic and fast.
 */
const enabled = process.env.DSH_MICROSANDBOX_E2E === '1' || process.env.npm_lifecycle_event === 'test:e2e'

describe.skipIf(!enabled)('microsandbox e2e', () => {
  it('runs a read-only command and blocks workspace writes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-micro-e2e-ro-'))
    writeFileSync(join(workspace, 'in.txt'), 'hello')
    const backend = new MicrosandboxBackend({ probe: 'version' })
    const wrapped = backend.confine(
      ['bash', '-c', 'cat in.txt; echo blocked > out.txt'],
      { mode: 'read-only', workspaceRoot: workspace },
    )
    const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.stderr).toMatch(/read-only file system|permission denied|operation not permitted/i)
  }, 180_000)


  it('runs the real shell executor with workdir mapping and DSH env forwarding', async () => {
    class FakePolicy extends Service {
      readonly defaultMode: SandboxMode = 'workspace-write'
      constructor(ctx: Context, readonly workspaceRoot: string) {
        super(ctx, 'sandboxPolicy')
      }
      resolve(): SandboxExecutionPolicy {
        return { mode: this.defaultMode, workspaceRoot: this.workspaceRoot }
      }
    }
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-shell-e2e-'))
    const sub = join(workspace, 'sub')
    mkdirSync(sub)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(FakePolicy, workspace)
    await ctx.plugin(MicrosandboxShellExecutor, { probe: 'version', image: 'debian', memory: '512M' } as Config)
    const shell = ctx.shell as MicrosandboxShellExecutor
    const result = await shell.run(shell.resolve({
      command: 'echo "$DSH_E2E" > out.txt && pwd',
      workdir: sub,
      dshEnv: { DSH_E2E: 'ok' } as Record<string, string>,
    }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('/work/sub')
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(readFileSync(join(sub, 'out.txt'), 'utf8').trim()).toBe('ok')
  })
  it('runs a workspace-write command in a mapped subdirectory with forwarded env', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-micro-e2e-rw-'))
    const backend = new MicrosandboxBackend({ probe: 'version' })
    const wrapped = backend.confine(
      ['bash', '-c', 'echo "$DSH_E2E" > out.txt && pwd'],
      { mode: 'workspace-write', workspaceRoot: workspace },
      { workdir: '/work', env: { DSH_E2E: 'ok' } },
    )
    const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('/work')
  })
})
