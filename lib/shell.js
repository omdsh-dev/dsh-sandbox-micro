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
import { accessSync, constants, statSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { ENV_OVERRIDES, LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import { MicrosandboxBackend, resolveGuestWorkdir } from './backend.js';
/** Node-local spawn codes proving executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT']);
function requirePolicy(policy) {
    if (policy === undefined) {
        throw new Error('@deepseek-ai/dsh-sandbox-micro/shell: resolved ShellExecSpec is missing sandboxPolicy');
    }
    return policy;
}
function isUsableWorkdir(path) {
    try {
        if (!statSync(path).isDirectory())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isRunnerSpawnFailure(error, runnerProgram, workdir) {
    if (runnerProgram === undefined || !isUsableWorkdir(workdir))
        return false;
    if (typeof error !== 'object' || error === null)
        return false;
    const { code, path, syscall } = error;
    if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code))
        return false;
    if (typeof syscall !== 'string')
        return false;
    const exactSyscall = `spawn ${runnerProgram}`;
    if (path === undefined)
        return syscall === exactSyscall;
    if (typeof path !== 'string' || path.length === 0 || path !== runnerProgram)
        return false;
    return syscall === 'spawn' || syscall === exactSyscall;
}
function classifyRunnerFailure(exitCode, stderr, rules) {
    if (exitCode === null || exitCode === 0)
        return undefined;
    const lines = stderr.split(/\r?\n/);
    for (const rule of rules) {
        if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode))
            continue;
        const informationalLines = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()));
        const fatalSignatures = rule.fatalSignatures
            .filter(signature => signature.trim().length > 0)
            .map(signature => signature.toLowerCase());
        for (const line of lines) {
            const lowered = line.toLowerCase();
            if (informationalLines.has(lowered))
                continue;
            if (fatalSignatures.some(signature => lowered.includes(signature)))
                return { detail: line };
        }
    }
    return undefined;
}
function matchesSignature(exitCode, stderr, signatures) {
    if (exitCode === null || exitCode === 0)
        return false;
    const lowered = stderr.toLowerCase();
    return signatures.some(signature => lowered.includes(signature.toLowerCase()));
}
export function buildShellConfinement(spec, policy, mode, backend) {
    const guestWorkdir = resolveGuestWorkdir(policy.workspaceRoot, spec.workdir);
    const env = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv };
    const confined = backend.confine(['bash', '-c', spec.command], { ...policy, mode }, { workdir: guestWorkdir, env });
    return {
        ...confined,
        runnerProgram: confined.argv[0],
        workdir: spec.workdir,
    };
}
export class MicrosandboxShellExecutor extends LocalBashExecutor {
    static inject = ['subprocess', 'sandboxPolicy'];
    static Config = z.object({
        cwd: z.string(),
        timeoutMs: z.number().default(120_000),
        maxTimeoutMs: z.number().default(600_000),
        maxOutputBytes: z.number().default(64_000),
        maxSpillBytes: z.number().default(64 * 1024 * 1024),
        graceMs: z.number().default(3_000),
    });
    internals = {};
    backend;
    policy;
    mode;
    processFacts = new Map();
    warned = false;
    constructor(ctx, config) {
        super(ctx, config);
        this.backend = new MicrosandboxBackend(config, this.internals);
        this.policy = ctx.sandboxPolicy;
        this.mode = ctx.sandboxPolicy.defaultMode;
    }
    /** The configured default mode — the capability fact the tool layer reads. */
    get sandboxMode() {
        return this.mode;
    }
    /** Stamp the deployment's resolved sandbox policy onto every request. */
    resolve(request) {
        return {
            ...super.resolve(request),
            sandboxPolicy: request.sandboxPolicy ?? this.policy.resolve(),
        };
    }
    async run(spec) {
        const policy = requirePolicy(spec.sandboxPolicy);
        const { mode } = policy;
        if (mode === 'danger-full-access') {
            const result = await super.run(spec);
            return { ...result, sandbox: { mode, denied: false } };
        }
        const confined = this.confineSpec(spec, policy, mode);
        let result;
        try {
            result = await this.runArgv(spec, confined.argv);
        }
        catch (error) {
            if (spec.signal?.aborted === true)
                spec.signal.throwIfAborted();
            if (isRunnerSpawnFailure(error, confined.runnerProgram, spec.workdir)) {
                throw new SandboxUnavailableError(mode, String(error));
            }
            throw error;
        }
        const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules);
        if (runnerFailure !== undefined) {
            throw new SandboxUnavailableError(mode, runnerFailure.detail);
        }
        return {
            ...result,
            sandbox: {
                mode,
                denied: matchesSignature(result.exitCode, result.stderr.text, confined.denialSignatures),
                enforcement: confined.enforcement,
            },
        };
    }
    start(spec) {
        const policy = requirePolicy(spec.sandboxPolicy);
        const { mode } = policy;
        if (mode === 'danger-full-access')
            return super.start(spec);
        const confined = this.confineSpec(spec, policy, mode);
        let proc;
        try {
            proc = this.startArgv(spec, confined.argv);
        }
        catch (error) {
            if (isRunnerSpawnFailure(error, confined.runnerProgram, spec.workdir)) {
                throw new SandboxUnavailableError(mode, String(error));
            }
            throw error;
        }
        this.processFacts.set(proc, {
            mode,
            enforcement: confined.enforcement,
            denialSignatures: confined.denialSignatures,
            runnerFailureRules: confined.runnerFailureRules,
            runnerProgram: confined.runnerProgram,
            workdir: spec.workdir,
        });
        return proc;
    }
    onProcessDone(proc, stderr, spawnFailed, spawnError) {
        const facts = this.processFacts.get(proc);
        if (facts !== undefined) {
            this.processFacts.delete(proc);
            const runnerFailed = spawnFailed
                ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir)
                : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined;
            proc.sandbox = {
                mode: facts.mode,
                denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
                enforcement: facts.enforcement,
                ...(runnerFailed ? { runnerFailed } : {}),
            };
        }
        super.onProcessDone(proc, stderr, spawnFailed, spawnError);
    }
    confineSpec(spec, policy, mode) {
        try {
            return buildShellConfinement(spec, requirePolicy(policy), mode, this.backend);
        }
        catch (error) {
            if (error instanceof SandboxUnavailableError && !this.warned) {
                this.warned = true;
                this.ctx.logger.warn(`@deepseek-ai/dsh-sandbox-micro/shell: ${error.message}`);
            }
            throw error;
        }
    }
}
export default MicrosandboxShellExecutor;
