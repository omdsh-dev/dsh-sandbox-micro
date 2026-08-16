import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MICROSANDBOX_CONFIG,
  MicrosandboxBackend,
  resolveGuestWorkdir,
  RUNNER_FAILURE_RULES,
} from '../src/backend.ts'

const invocation = ['node', 'fake-msb.cjs']

function backend(config: ConstructorParameters<typeof MicrosandboxBackend>[0] = {}) {
  return new MicrosandboxBackend(config, {
    resolveInvocation: () => invocation,
    probe: () => true,
  })
}

describe('microsandbox backend: argv construction', () => {
  it('never introduces a shell wrapper and preserves shell metacharacters verbatim', () => {
    const out = backend().confine(
      ['bash', '-c', '" & echo HOST_RCE > C:/temp/x.txt & rem "'],
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
    )
    expect(out.argv).not.toContain('cmd')
    expect(out.argv).not.toContain('cmd.exe')
    expect(out.argv).not.toContain('/c')
    expect(out.argv.slice(-4)).toEqual([
      '--',
      'bash',
      '-c',
      '" & echo HOST_RCE > C:/temp/x.txt & rem "',
    ])
  })

  it('maps read-only to --no-net and a :ro mount', () => {
    const out = backend({ timeout: '60s', extraFlags: ['--cpus', '2'] }).confine(
      ['bash', '-c', 'true'],
      { mode: 'read-only', workspaceRoot: 'C:/workspace' },
    )
    expect(out.argv).toContain('--no-net')
    expect(out.argv).toContain('--timeout')
    expect(out.argv).toContain('60s')
    expect(out.argv).toContain('--cpus')
    expect(out.argv).toContain('2')
    expect(out.argv).toContain('C:/workspace:/work:ro')
    expect(out.argv).toContain('-w')
    expect(out.argv).toContain('/work')
  })

  it('omits --no-net when networking is explicitly enabled', () => {
    const out = backend({ allowNetwork: true }).confine(
      ['bash', '-c', 'true'],
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
    )
    expect(out.argv).not.toContain('--no-net')
  })

  it('forwards the trusted environment map with -e and a mapped guest workdir', () => {
    const out = backend().confine(
      ['bash', '-c', 'pwd'],
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
      { workdir: '/work/sub', env: { DSH_HOME: 'C:/home', TERM: 'dumb' } },
    )
    expect(out.argv).toContain('-e')
    expect(out.argv).toContain('DSH_HOME=C:/home')
    expect(out.argv).toContain('TERM=dumb')
    expect(out.argv).toContain('-w')
    expect(out.argv).toContain('/work/sub')
  })

  it('refuses workdirs outside the guest workspace mount', () => {
    expect(() => backend().confine(
      ['bash', '-c', 'true'],
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
      { workdir: '/etc' },
    )).toThrow(/must be \/work or below/)
  })
})

describe('microsandbox backend: workdir mapping', () => {
  it('maps a Windows subdirectory to /work/sub', () => {
    expect(resolveGuestWorkdir('C:/workspace', 'C:/workspace/sub', 'win32')).toBe('/work/sub')
    expect(resolveGuestWorkdir('C:/workspace', 'C:/workspace', 'win32')).toBe('/work')
  })

  it('maps a POSIX subdirectory to /work/sub', () => {
    expect(resolveGuestWorkdir('/workspace', '/workspace/a/b', 'linux')).toBe('/work/a/b')
  })

  it('rejects escaping and sibling paths', () => {
    expect(() => resolveGuestWorkdir('C:/workspace', 'C:/workspace/../outside', 'win32')).toThrow(/outside/)
    expect(() => resolveGuestWorkdir('/workspace', '/other', 'linux')).toThrow(/outside/)
  })
})

describe('microsandbox backend: config and probe', () => {
  it('rejects cmd shim paths instead of routing through cmd.exe', () => {
    expect(() => new MicrosandboxBackend({ msbPath: 'msb.cmd' })).toThrow(/\.CMD\/\.BAT/)
    expect(() => new MicrosandboxBackend({ msbPath: 'C:/tools/msb.bat' })).toThrow(/\.CMD\/\.BAT/)
  })

  it('rejects malformed memory and timeout values', () => {
    expect(() => new MicrosandboxBackend({ memory: 'lots' })).toThrow(/memory/)
    expect(() => new MicrosandboxBackend({ timeout: 'soon' })).toThrow(/timeout/)
  })

  it('caches one probe verdict for the provider lifetime', () => {
    let probes = 0
    const probeBackend = new MicrosandboxBackend({}, {
      resolveInvocation: () => invocation,
      probe: () => {
        probes += 1
        return true
      },
    })
    expect(probeBackend.ensureAvailable()).toBe(true)
    expect(probeBackend.ensureAvailable()).toBe(true)
    expect(probes).toBe(1)
  })

  it('ships runner-failure signatures matching observed msb diagnostics', () => {
    const signatures = RUNNER_FAILURE_RULES.flatMap(rule => rule.fatalSignatures)
    expect(signatures).toContain('error: failed to start')
    expect(signatures).toContain('error: image error')
    expect(signatures).toContain('the host path for one of the mounts')
  })

  it('provides the documented default config', () => {
    expect(DEFAULT_MICROSANDBOX_CONFIG.image).toBe('debian')
    expect(DEFAULT_MICROSANDBOX_CONFIG.allowNetwork).toBe(false)
    expect(DEFAULT_MICROSANDBOX_CONFIG.probe).toBe('doctor')
  })
})
