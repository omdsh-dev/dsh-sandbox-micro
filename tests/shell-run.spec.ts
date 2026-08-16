import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { MicrosandboxShellExecutor, type Config } from '../src/shell.ts'

class FakePolicy extends Service {
  readonly defaultMode: SandboxMode = 'workspace-write'
  constructor(ctx: Context, readonly workspaceRoot: string) {
    super(ctx, 'sandboxPolicy')
  }
  resolve(): SandboxExecutionPolicy {
    return { mode: this.defaultMode, workspaceRoot: this.workspaceRoot }
  }
}

async function setup(root: string, runnerScript: string, config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FakePolicy, root)
  await ctx.plugin(MicrosandboxShellExecutor, config as Config)
  const shell = ctx.shell as MicrosandboxShellExecutor
  shell.internals.resolveInvocation = () => [process.execPath, runnerScript]
  shell.internals.probe = () => true
  return { ctx, shell }
}

describe('microsandbox shell executor: run path', () => {
  it('hands the local subprocess runtime the msb argv with mapped workdir and forwarded DSH env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-shell-run-'))
    const sub = join(root, 'sub')
    mkdirSync(sub)
    const log = join(root, 'fake-msb.json')
    const runner = join(root, 'fake-msb.cjs')
    writeFileSync(runner, `
const fs = require('node:fs')
const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const env = {}
let workdir = process.cwd()
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-e') {
    const kv = argv[i + 1]
    const eq = kv.indexOf('=')
    env[kv.slice(0, eq)] = kv.slice(eq + 1)
  } else if (argv[i] === '-w') {
    workdir = argv[i + 1]
  }
}
fs.writeFileSync(process.env.DSH_FAKE_LOG, JSON.stringify({ argv, env, workdir, inner: sep >= 0 ? argv.slice(sep + 1) : [] }))
process.exit(0)
`)
    const { shell } = await setup(root, runner, { image: 'alpine', memory: '768M' })
    const result = await shell.run(shell.resolve({
      command: 'echo hi',
      workdir: sub,
      env: { DSH_FAKE_LOG: log },
      dshEnv: { DSH_SESSION_ID: 's-1' } as Record<string, string>,
    }))
    expect(result.exitCode).toBe(0)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    const seen = JSON.parse(readFileSync(log, 'utf8')) as {
      argv: string[]
      env: Record<string, string>
      workdir: string
      inner: string[]
    }
    expect(seen.argv[0]).toBe('run')
    expect(seen.argv).toContain('768M')
    expect(seen.argv).toContain('alpine')
    expect(seen.argv).toContain('-w')
    expect(seen.argv).toContain('/work/sub')
    expect(seen.argv).toContain('DSH_SESSION_ID=s-1')
    expect(seen.argv).toContain('NO_COLOR=1')
    expect(seen.argv).toContain('TERM=dumb')
    expect(seen.env.DSH_SESSION_ID).toBe('s-1')
    expect(seen.workdir).toBe('/work/sub')
    expect(seen.inner).toEqual(['bash', '-c', 'echo hi'])
  })

  it('classifies msb startup failures as SANDBOX_UNAVAILABLE', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-shell-fail-'))
    const runner = join(root, 'failing-msb.cjs')
    writeFileSync(runner, `
process.stderr.write('error: failed to start "fake"\n')
process.exit(1)
`)
    const { shell } = await setup(root, runner)
    await expect(shell.run(shell.resolve({ command: 'true', workdir: root })))
      .rejects.toThrow(/error: failed to start/)
  })
})
