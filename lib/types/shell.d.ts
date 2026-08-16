/**
 * Microsandbox shell executor: replaces `ctx.shell` with a Linux `bash -c`
 * executor that runs every model shell command inside a fresh microVM.
 *
 * Unlike the raw `ctx.sandbox` seam, this provider has access to the fully
 * resolved `ShellExecSpec`, so it can preserve:
 * - the caller's workdir (mapped from the mounted workspace root to /work)
 * - the trusted per-execution environment (`ENV_OVERRIDES` + `spec.env` +
 *   `spec.dshEnv`) through explicit `msb run -e KEY=VALUE` args
 * and report runner-failure / denial facts exactly like the sandboxing
 * executor it replaces.
 *
 * @module @deepseek-ai/dsh-sandbox-micro/shell
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local';
import type { ConfinedArgv, ConfinedSandboxMode, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { MicrosandboxBackend, type MicrosandboxConfig, type MicrosandboxInternals } from './backend.ts';
export interface Config extends LocalConfig, MicrosandboxConfig {
}
interface ShellConfinement extends ConfinedArgv {
    runnerProgram: string | undefined;
    workdir: string;
}
export declare function buildShellConfinement(spec: Pick<ShellExecSpec, 'command' | 'workdir' | 'env' | 'dshEnv'>, policy: SandboxExecutionPolicy, mode: ConfinedSandboxMode, backend: MicrosandboxBackend): ShellConfinement;
export declare class MicrosandboxShellExecutor extends LocalBashExecutor {
    static inject: string[];
    static Config: z<LocalConfig>;
    readonly internals: MicrosandboxInternals;
    private readonly backend;
    private readonly policy;
    private readonly mode;
    private readonly processFacts;
    private warned;
    constructor(ctx: Context, config: Config);
    /** The configured default mode — the capability fact the tool layer reads. */
    get sandboxMode(): SandboxMode;
    /** Stamp the deployment's resolved sandbox policy onto every request. */
    resolve(request: ShellExecRequest): ShellExecSpec;
    run(spec: ShellExecSpec): Promise<ShellRunResult>;
    start(spec: ShellExecSpec): ShellProcess;
    protected onProcessDone(proc: ShellProcess, stderr: string, spawnFailed: boolean, spawnError?: unknown): void;
    private confineSpec;
}
export default MicrosandboxShellExecutor;
