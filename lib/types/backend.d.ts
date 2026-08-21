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
import type { ConfinedArgv, RunnerFailureRule, SandboxPolicy } from '@deepseek-ai/dsh-sandbox';
/** stderr substrings produced when the sandbox VM denies a file effect. */
export declare const DENIAL_SIGNATURES: readonly ['read-only file system', 'permission denied', 'operation not permitted'];
/**
 * Fatal stderr substrings emitted by microsandbox itself when it fails before
 * the wrapped command runs. Calibrated against msb 0.6.12 output:
 *
 *   error: failed to start "<name>" / the host path for one of the mounts ...
 *   error: image error: registry error: ...
 *
 * Deliberately kept specific so an ordinary command that prints `error:` is
 * not mistaken for a runner failure.
 */
export declare const RUNNER_FAILURE_RULES: readonly RunnerFailureRule[];
export type MicrosandboxProbe = 'doctor' | 'version';
export interface MicrosandboxConfig {
    /** OCI image the sandbox boots from. Must contain the wrapped program. */
    image: string;
    /** VM memory allocation, e.g. "512M", "1G". */
    memory: string;
    /**
     * Optional msb override. Must be an executable or a Node-compatible script
     * path — never a `.CMD`/`.BAT` shim, because routing through cmd.exe would
     * re-introduce Windows shell parsing. Empty uses the bundled microsandbox
     * Node shim from the `microsandbox` dependency.
     */
    msbPath: string;
    /** Command timeout passed to msb (e.g. "60s", "5m"); unset runs to completion. */
    timeout: string | undefined;
    /** Extra `msb run` flags, appended verbatim (e.g. ["--cpus", "2"]). */
    extraFlags: string[];
    /** When false (default), the guest has no network. */
    allowNetwork: boolean;
    /** Startup probe: `doctor` also checks host virtualization prerequisites. */
    probe: MicrosandboxProbe;
}
export declare const DEFAULT_MICROSANDBOX_CONFIG: MicrosandboxConfig;
/** Test seam: replace invocation resolution / probing without touching a real msb. */
export interface MicrosandboxInternals {
    resolveInvocation?: () => readonly string[];
    probe?: (invocation: readonly string[]) => boolean;
    probeTimeoutMs?: number;
}
export interface MicrosandboxWrapOptions {
    /** Guest workdir override. Defaults to `/work`. Must stay below `/work`. */
    workdir?: string;
    /** Environment entries forwarded into the guest with `-e KEY=VALUE`. */
    env?: Record<string, string>;
}
/**
 * Map a host workdir inside the mounted workspace to its guest path. The
 * workspace root is mounted at `/work`; anything outside it has no guest
 * counterpart and is refused rather than silently run in the wrong directory.
 */
export declare function resolveGuestWorkdir(workspaceRoot: string, hostWorkdir: string, platform?: NodeJS.Platform): string;
export declare class MicrosandboxBackend {
    readonly config: MicrosandboxConfig;
    private readonly internals;
    private invocation;
    private probeResult;
    private lastProbeDetail;
    constructor(config?: Partial<MicrosandboxConfig>, internals?: MicrosandboxInternals);
    /** Resolve the safe invocation once. */
    resolveInvocation(): readonly string[];
    /** Probe `msb` once per provider lifetime; the verdict is cached. */
    ensureAvailable(): boolean;
    private defaultProbe;
    private spawnProbe;
    /**
     * Build the enforcing argv for one execution. When `options` is absent (the
     * raw `ctx.sandbox` seam) the guest cwd is `/work` and no environment is
     * forwarded — those facts are not part of the `SandboxProvider.confine`
     * contract. The shell-executor entrypoint supplies both.
     */
    confine(argv: readonly string[], policy: SandboxPolicy, options?: MicrosandboxWrapOptions): ConfinedArgv;
}
export default MicrosandboxBackend;
