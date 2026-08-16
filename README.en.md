# dsh-sandbox-micro

[中文](README.md)

A microsandbox plugin bundle for DeepSeek Harness: it replaces the model-facing `ctx.shell` with a `bash -c` executor running inside a fresh Linux microVM, while retaining a direct `ctx.sandbox` seam provider.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Security model

- **No `cmd.exe` or shell wrapping for untrusted argv.** The previous Windows implementation launched npm `.CMD` shims through `cmd /c`, which let the host shell parse `&`, quotes, and `%VAR%` in model commands. This plugin runs the Node shim shipped by the `microsandbox` dependency (`node .../bin/microsandbox.cjs`) and rejects `.CMD` / `.BAT` override paths.
- **Fail-closed:** before the first confinement it probes `msb --version` and `msb doctor` (host virtualization prerequisites). The verdict is cached; failures throw `SANDBOX_UNAVAILABLE` — never an unconfined fallback.
- **Execution-time runner failures are classified** with `runnerFailureRules` calibrated against real msb 0.6.9 stderr (image pull, mount path, sandbox start, and invalid-config errors).
- Networking is disabled by default with `--no-net`; opt in with `allowNetwork: true`.

## Architecture

The package exposes two Cordis entrypoints:

| Entrypoint | Service | Purpose |
|---|---|---|
| `@deepseek-ai/dsh-sandbox-micro` | `ctx.sandbox` | Compatibility provider for direct `SandboxProvider.confine()` calls. The seam carries no env/cwd, so the guest cwd is `/work` |
| `@deepseek-ai/dsh-sandbox-micro/shell` | `ctx.shell` | The executor actually used by model shell tools. It sees the full `ShellExecSpec`, maps workdir to `/work/<sub>`, and forwards `ENV_OVERRIDES`, `spec.env`, and `DSH_*` via `-e KEY=VALUE` |

`cordis.patch.yml`:

- disables the official `sandbox` / `bash-sandbox` / `pwsh-sandbox` rows
- inserts `sandbox-micro` and `shell-micro`
- enables `tool-bash` on every platform
- disables `tool-pwsh` (PowerShell syntax cannot run in the Debian guest)

## Prerequisites

- Node `^22.19.0 || >=24.0.0`
- `microsandbox` 0.6.9+ (installed as a dependency)
- Windows: Windows Hypervisor Platform; Linux/macOS: an msb-supported local backend
- The image must contain the wrapped program; the default `debian` image has `bash` and coreutils

## Installation

### Profile Bundle (recommended)

```sh
dsh plugin --profile web add github:omdsh-dev/dsh-sandbox-micro
dsh plugin --profile headless add github:omdsh-dev/dsh-sandbox-micro
```

`dsh.bundle.patch` adds the bundle to the profile layer stack automatically.

### Local tarball

```sh
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-sandbox-micro-0.0.1.tgz
```

### Verification

```sh
dsh --profile web --dump-config | grep -E 'sandbox-micro|shell-micro'
dsh run "run a bash command"
```

## Configuration

`shell-micro` inherits every `dsh-bash-local` field and adds:

| Field | Default | Meaning |
|---|---|---|
| `image` | `debian` | Guest OCI image |
| `memory` | `512M` | VM memory |
| `msbPath` | `""` | Executable override; empty uses the bundled microsandbox Node shim |
| `timeout` | unset | `msb run --timeout`, e.g. `60s` |
| `extraFlags` | `[]` | Extra `msb run` flags, e.g. `["--cpus", "2"]` |
| `allowNetwork` | `false` | Removes `--no-net` when true |
| `probe` | `doctor` | Startup probe level: `doctor` or `version` |

`sandbox-micro` accepts the same microsandbox fields.

## Policy mapping

| Sandbox mode | Guest file effects | Network |
|---|---|---|
| `read-only` | workspace mounted at `/work` with `:ro` | off by default |
| `workspace-write` | workspace mounted read-write at `/work` | off by default |
| `danger-full-access` | bypasses the VM (consumer passthrough) | — |

## Known boundaries

- The guest root filesystem and `/tmp` are a fresh writable layer per command and are discarded on exit; policy semantics target host file effects.
- `ShellExecSpec.workdir` must live inside `sandboxPolicy.workspaceRoot`; otherwise execution is refused.
- Bash only; the PowerShell tool is disabled by the patch.
- Model-visible paths switch to the Linux `/work` view; filesystem tools still use host paths and agree through the workspace mount.

## Tests

```sh
npm run check       # typecheck + unit tests + build
npm run test:e2e    # optional: real microVM smoke tests
```

## License

MIT
