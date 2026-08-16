/**
 * Microsandbox-backed sandbox provider for the `ctx.sandbox` seam.
 *
 * The provider exists for direct `ctx.sandbox.confine(argv, policy)`
 * consumers. The patch shipped by this bundle routes model-facing shell
 * commands through `@deepseek-ai/dsh-sandbox-micro/shell` instead, because
 * that entrypoint can also preserve per-call workdir and `DSH_*` environment
 * facts that the raw sandbox seam does not carry.
 *
 * Policy mapping:
 * - `read-only`        -> `--no-net`, workspace mounted read-only
 * - `workspace-write`  -> `--no-net`, workspace mounted read-write
 * - `danger-full-access` is handled by consumers before reaching this seam.
 *
 * Fails closed with SANDBOX_UNAVAILABLE when the bundled `msb` (or the
 * configured override) cannot run or its host prerequisites are missing.
 * @module @deepseek-ai/dsh-sandbox-micro
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SandboxProvider,
  SandboxUnavailableError,
  type ConfinedArgv,
  type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import { MicrosandboxBackend, type MicrosandboxConfig, type MicrosandboxInternals } from './backend.ts'

const PLUGIN_NAME = '@deepseek-ai/dsh-sandbox-micro'

export { DENIAL_SIGNATURES, RUNNER_FAILURE_RULES, resolveGuestWorkdir } from './backend.ts'
export type { MicrosandboxConfig, MicrosandboxInternals, MicrosandboxProbe, MicrosandboxWrapOptions } from './backend.ts'

export interface Config extends MicrosandboxConfig {}

/** Test seam: replace invocation resolution / probing without touching a real msb. */
export interface SandboxMicroInternals extends MicrosandboxInternals {}

const DEFAULT_CONFIG: Config = {
  image: 'debian',
  memory: '512M',
  msbPath: '',
  timeout: undefined,
  extraFlags: [],
  allowNetwork: false,
  probe: 'doctor',
}

export default class MicrosandboxProvider extends SandboxProvider {
  static Config: z<Config> = z.object({
    image: z.string().default('debian'),
    memory: z.string().default('512M'),
    msbPath: z.string().default(''),
    timeout: z.string(),
    extraFlags: z.array(z.string()).default([]),
    allowNetwork: z.boolean().default(false),
    probe: z.union([z.const('doctor'), z.const('version')]).default('doctor'),
  })

  readonly internals: MicrosandboxInternals = {}
  private readonly backend: MicrosandboxBackend
  private warned = false

  constructor(ctx: Context, config: Config = DEFAULT_CONFIG) {
    super(ctx)
    this.backend = new MicrosandboxBackend(config, this.internals)
  }

  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    try {
      return this.backend.confine(argv, policy)
    } catch (error) {
      if (error instanceof SandboxUnavailableError && !this.warned) {
        this.warned = true
        this.ctx.logger.warn(`${PLUGIN_NAME}: ${error.message}`)
      }
      throw error
    }
  }
}
