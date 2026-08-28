/**
 * Shared microsandbox execution backend for `@deepseek-ai/dsh-sandbox-micro`.
 *
 * The backend owns the only subprocess-facing surface of this package:
 * resolving a safe msb invocation (the npm-installed Node shim, or an
 * operator-supplied executable path), probing it once, and building the
 * `msb run` argv for one confined execution.
 *
 * SECURITY: this package never routes untrusted argv through `cmd.exe` or
 * any other shell. Windows `.CMD` shims are explicitly rejected in favor of
 * the bundled Node shim (`microsandbox/bin/microsandbox.cjs`), so shell
 * metacharacters in a model command stay ordinary argv entries.
 *
 * @module @deepseek-ai/dsh-sandbox-micro/backend
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, ConfinedSandboxMode, RunnerFailureRule, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const require = createRequire(import.meta.url)

/** stderr substrings produced when the sandbox VM denies a file effect. */
export const DENIAL_SIGNATURES = [
  'read-only file system',
  'permission denied',
  'operation not permitted',
] as const

/**
 * Fatal stderr substrings emitted by microsandbox itself when it fails before
 * the wrapped command runs. Calibrated against msb 0.6.15 output:
 *
 *   error: failed to start "<name>" / the host path for one of the mounts ...
 *   error: image error: registry error: ...
 *
 * Deliberately kept specific so an ordinary command that prints `error:` is
 * not mistaken for a runner failure.
 */
export const RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [{
  fatalSignatures: [
    'microsandbox:',
    'error: failed to start',
    'error: invalid config',
    'error: image error',
    'image error: registry error',
    'failed to pull image',
    'the host path for one of the mounts',
    'error: unable to',
  ],
}]

export type MicrosandboxProbe = 'doctor' | 'version'

export interface MicrosandboxConfig {
  /** OCI image the sandbox boots from. Must contain the wrapped program. */
  image: string
  /** VM memory allocation, e.g. "512M", "1G". */
  memory: string
  /**
   * Optional msb override. Must be an executable or a Node-compatible script
   * path — never a `.CMD`/`.BAT` shim, because routing through cmd.exe would
   * re-introduce Windows shell parsing. Empty uses the bundled microsandbox
   * Node shim from the `microsandbox` dependency.
   */
  msbPath: string
  /** Command timeout passed to msb (e.g. "60s", "5m"); unset runs to completion. */
  timeout: string | undefined
  /** Extra `msb run` flags, appended verbatim (e.g. ["--cpus", "2"]). */
  extraFlags: string[]
  /** When false (default), the guest has no network. */
  allowNetwork: boolean
  /** Startup probe: `doctor` also checks host virtualization prerequisites. */
  probe: MicrosandboxProbe
}

export const DEFAULT_MICROSANDBOX_CONFIG: MicrosandboxConfig = {
  image: 'debian',
  memory: '512M',
  msbPath: '',
  timeout: undefined,
  extraFlags: [],
  allowNetwork: false,
  probe: 'doctor',
}

/** Test seam: replace invocation resolution / probing without touching a real msb. */
export interface MicrosandboxInternals {
  resolveInvocation?: () => readonly string[]
  probe?: (invocation: readonly string[]) => boolean
  probeTimeoutMs?: number
}

export interface MicrosandboxWrapOptions {
  /** Guest workdir override. Defaults to `/work`. Must stay below `/work`. */
  workdir?: string
  /** Environment entries forwarded into the guest with `-e KEY=VALUE`. */
  env?: Record<string, string>
}

function assertSingleLine(name: string, value: string): void {
  if (/[\r\n\0]/u.test(value)) throw new Error(`dsh-sandbox-micro: ${name} must be a single line without NUL`)
}

function assertConfig(config: MicrosandboxConfig): void {
  if (config.image.trim().length === 0) throw new Error('dsh-sandbox-micro: image must be a non-empty image reference')
  assertSingleLine('image', config.image)
  if (!/^\d+(?:[KMGTPE](?:i?B)?|B)?$/iu.test(config.memory)) {
    throw new Error(`dsh-sandbox-micro: memory must look like "512M", "1G", "512MiB", or bytes; got ${JSON.stringify(config.memory)}`)
  }
  if (config.msbPath.trim().length !== 0) {
    assertSingleLine('msbPath', config.msbPath)
    if (/\.(?:cmd|bat)$/iu.test(config.msbPath)) {
      throw new Error(`dsh-sandbox-micro: msbPath must be an executable, not a .CMD/.BAT shim (${config.msbPath}); omit it to use the bundled microsandbox Node shim`)
    }
  }
  if (config.timeout !== undefined) {
    assertSingleLine('timeout', config.timeout)
    if (!/^\d+(?:ms|s|m|h)$/iu.test(config.timeout)) {
      throw new Error(`dsh-sandbox-micro: timeout must look like "60s", "5m", or "1h"; got ${JSON.stringify(config.timeout)}`)
    }
  }
  for (const flag of config.extraFlags) {
    assertSingleLine('extraFlags[]', flag)
    if (flag === '--') throw new Error('dsh-sandbox-micro: extraFlags must not contain the bare "--" separator')
  }
  if (config.probe !== 'doctor' && config.probe !== 'version') {
    throw new Error(`dsh-sandbox-micro: probe must be "doctor" or "version"; got ${JSON.stringify(config.probe)}`)
  }
}

/**
 * Resolve the bundled microsandbox CLI as `[process.execPath, <shim>]`.
 * `microsandbox` is a regular dependency, so the profile installer materializes
 * it next to this package; no global `msb` install is required.
 */
function resolveBundledInvocation(): readonly string[] {
  const entry = require.resolve('microsandbox')
  const packageRoot = dirname(dirname(entry))
  const shim = join(packageRoot, 'bin', 'microsandbox.cjs')
  if (!existsSync(shim)) {
    throw new Error(`dsh-sandbox-micro: bundled microsandbox shim not found at ${shim}`)
  }
  return [process.execPath, shim]
}

/**
 * Map a host workdir inside the mounted workspace to its guest path. The
 * workspace root is mounted at `/work`; anything outside it has no guest
 * counterpart and is refused rather than silently run in the wrong directory.
 */
export function resolveGuestWorkdir(
  workspaceRoot: string,
  hostWorkdir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === 'win32' ? win32 : posix
  const root = path.resolve(workspaceRoot)
  const cwd = path.resolve(hostWorkdir)
  const rel = path.relative(root, cwd)
  if (rel === '') return '/work'
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`dsh-sandbox-micro: workdir ${JSON.stringify(hostWorkdir)} is outside the mounted workspace ${JSON.stringify(workspaceRoot)}`)
  }
  const segments = rel.split(path.sep)
  if (segments.some(segment => segment === '..')) {
    throw new Error(`dsh-sandbox-micro: workdir ${JSON.stringify(hostWorkdir)} escapes the mounted workspace ${JSON.stringify(workspaceRoot)}`)
  }
  return posix.join('/work', ...segments)
}

/** Validate the guest workdir supplied by a caller (provider or shell wrapper). */
function assertGuestWorkdir(workdir: string): string {
  const normalized = posix.normalize(workdir)
  if (normalized !== '/work' && !normalized.startsWith('/work/')) {
    throw new Error(`dsh-sandbox-micro: guest workdir must be /work or below; got ${JSON.stringify(workdir)}`)
  }
  return normalized
}

/** Build `-e KEY=VALUE` args from the trusted per-execution environment map. */
function environmentArgs(env: Record<string, string> | undefined): string[] {
  if (env === undefined) return []
  const args: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`dsh-sandbox-micro: environment key ${JSON.stringify(key)} cannot be forwarded into the guest`)
    }
    assertSingleLine('env value', value)
    args.push('-e', `${key}=${value}`)
  }
  return args
}

export class MicrosandboxBackend {
  readonly config: MicrosandboxConfig
  private readonly internals: MicrosandboxInternals
  private invocation: readonly string[] | undefined
  private probeResult: { available: boolean; detail: string } | undefined
  private lastProbeDetail: string | undefined

  constructor(config: Partial<MicrosandboxConfig> = {}, internals: MicrosandboxInternals = {}) {
    this.config = { ...DEFAULT_MICROSANDBOX_CONFIG, ...config }
    assertConfig(this.config)
    this.internals = internals
  }

  /** Resolve the safe invocation once. */
  resolveInvocation(): readonly string[] {
    if (this.invocation !== undefined) return this.invocation
    this.invocation = this.internals.resolveInvocation?.()
      ?? (this.config.msbPath.trim() === '' ? resolveBundledInvocation() : [this.config.msbPath])
    return this.invocation
  }

  /** Probe `msb` once per provider lifetime; the verdict is cached. */
  ensureAvailable(): boolean {
    if (this.probeResult !== undefined) return this.probeResult.available
    const invocation = this.resolveInvocation()
    const available = this.internals.probe?.(invocation) ?? this.defaultProbe(invocation)
    this.probeResult = {
      available,
      detail: available ? '' : `microsandbox probe failed for ${JSON.stringify(invocation.join(' '))}: ${this.lastProbeDetail ?? 'unusable'}`,
    }
    return available
  }

  private defaultProbe(invocation: readonly string[]): boolean {
    const timeout = this.internals.probeTimeoutMs ?? 15_000
    const version = this.spawnProbe(invocation, ['--version'], timeout)
    this.lastProbeDetail = version.detail
    if (!version.ok) return false
    if (this.config.probe === 'version') return true
    const doctor = this.spawnProbe(invocation, ['doctor'], timeout)
    this.lastProbeDetail = doctor.detail
    return doctor.ok
  }

  private spawnProbe(
    invocation: readonly string[],
    args: readonly string[],
    timeout: number,
  ): { ok: boolean; detail: string } {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('dsh-sandbox-micro: probeTimeoutMs must be a positive finite number')
    }
    const program = invocation[0]
    if (program === undefined) return { ok: false, detail: 'empty msb invocation' }
    try {
      const result = spawnSync(program, [...invocation.slice(1), ...args], {
        stdio: 'ignore',
        timeout,
        windowsHide: true,
      })
      if (result.status === 0) return { ok: true, detail: '' }
      if (result.error !== undefined) return { ok: false, detail: String(result.error) }
      return {
        ok: false,
        detail: `exit ${String(result.status ?? 'null')} (signal ${result.signal ?? 'none'})`,
      }
    } catch (error) {
      return { ok: false, detail: String(error) }
    }
  }

  /**
   * Build the enforcing argv for one execution. When `options` is absent (the
   * raw `ctx.sandbox` seam) the guest cwd is `/work` and no environment is
   * forwarded — those facts are not part of the `SandboxProvider.confine`
   * contract. The shell-executor entrypoint supplies both.
   */
  confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    options: MicrosandboxWrapOptions = {},
  ): ConfinedArgv {
    const mode: ConfinedSandboxMode = policy.mode
    let available: boolean
    try {
      available = this.ensureAvailable()
    } catch (error) {
      throw new SandboxUnavailableError(mode, String(error))
    }
    if (!available) {
      const detail = this.probeResult?.detail ?? 'microsandbox is not available'
      throw new SandboxUnavailableError(mode, detail)
    }
    let invocation: readonly string[]
    try {
      invocation = this.resolveInvocation()
    } catch (error) {
      throw new SandboxUnavailableError(mode, String(error))
    }
    const prefix = [...invocation, 'run', '--quiet', '--no-tty', '--security', 'restricted']
    if (!this.config.allowNetwork) prefix.push('--no-net')
    if (this.config.timeout !== undefined) prefix.push('--timeout', this.config.timeout)
    prefix.push('-m', this.config.memory, ...this.config.extraFlags)
    const mountOption = mode === 'read-only' ? ':ro' : ''
    prefix.push('-v', `${policy.workspaceRoot}:/work${mountOption}`)
    prefix.push('-w', assertGuestWorkdir(options.workdir ?? '/work'))
    prefix.push(...environmentArgs(options.env))
    prefix.push(this.config.image)
    return {
      argv: [...prefix, '--', ...argv],
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }
}

export default MicrosandboxBackend
