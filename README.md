# dsh-sandbox-micro

[English](README.en.md)

DeepSeek Harness 的 microsandbox 插件 bundle：把模型可见的 `ctx.shell` 替换为 **Linux 微虚拟机** 中的 `bash -c` 执行器，同时保留一个直接面向 `ctx.sandbox` seam 的 provider。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 安全模型

- **不使用 `cmd.exe` 或其他 shell 包装不可信 argv**。Windows 上历史实现通过 `cmd /c` 启动 npm `.CMD` shim，会让模型命令中的 `&` / 引号 / `%VAR%` 被宿主机 shell 解析。本插件改为直接运行 `microsandbox` 依赖自带的 Node shim（`node .../bin/microsandbox.cjs`），并显式拒绝 `.CMD` / `.BAT` 覆盖路径。
- **fail-closed**：首次 confinement 前会探测 `msb --version` 和 `msb doctor`（检查宿主虚拟化前置条件）；失败时缓存判决并抛出 `SANDBOX_UNAVAILABLE`，绝不退回未隔离执行。
- **执行期 runner 失败可识别**：`runnerFailureRules` 按 msb 0.6.12 的真实 stderr 方言校准，覆盖镜像拉取、挂载路径、沙箱启动和无效配置错误。
- 默认 `--no-net`；可通过 `allowNetwork: true` 显式放开。

## 架构

这个包暴露两个 Cordis 入口：

| 入口 | 服务 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-sandbox-micro` | `ctx.sandbox` | 直接调用 `SandboxProvider.confine()` 的兼容 provider。seam 不携带 env/cwd，因此 guest 固定为 `/work` |
| `@deepseek-ai/dsh-sandbox-micro/shell` | `ctx.shell` | **模型 shell 工具实际使用的执行器**。它能看到完整 `ShellExecSpec`，会映射 workdir 到 `/work/<sub>`，并通过 `-e KEY=VALUE` 转发 `ENV_OVERRIDES`、`spec.env` 与 `DSH_*` |

`cordis.patch.yml` 会：

- 禁用官方 `sandbox` / `bash-sandbox` / `pwsh-sandbox` row
- 插入 `sandbox-micro` 与 `shell-micro`
- 全平台启用 `tool-bash`
- 禁用 `tool-pwsh`（其 PowerShell 方言无法运行在 Debian guest 中）

## 前置条件

- Node `^22.19.0 || >=24.0.0`
- `microsandbox` 0.6.12+（已作为 dependency 随包安装）
- Windows：Windows Hypervisor Platform；Linux/macOS：msb 支持的本地后端
- 镜像必须包含被包装的程序；默认 `debian` 包含 `bash` 与常用 coreutils

## 安装

### Profile Bundle（推荐）

```sh
dsh plugin --profile web add github:omdsh-dev/dsh-sandbox-micro
dsh plugin --profile headless add github:omdsh-dev/dsh-sandbox-micro
```

包内 `dsh.bundle.patch` 会在安装后自动加入 profile layer stack。

### 本地 tarball

```sh
npm pack
dsh plugin --profile web add ./deepseek-ai-dsh-sandbox-micro-0.0.1.tgz
```

### 验证

```sh
dsh --profile web --dump-config | grep -E 'sandbox-micro|shell-micro'
dsh run "运行 bash 命令验证"
```

## 配置

`shell-micro` 继承 `dsh-bash-local` 的全部字段，并增加：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `image` | `debian` | guest 使用的 OCI 镜像 |
| `memory` | `512M` | VM 内存 |
| `msbPath` | `""` | 可执行文件覆盖；留空使用内置 microsandbox Node shim |
| `timeout` | 未设置 | `msb run --timeout`，例如 `60s` |
| `extraFlags` | `[]` | 追加的 `msb run` flag，例如 `["--cpus", "2"]` |
| `allowNetwork` | `false` | `true` 时移除 `--no-net` |
| `probe` | `doctor` | 启动探测级别：`doctor` 或 `version` |

`sandbox-micro` 使用同一组 microsandbox 字段。

## 策略映射

| Sandbox mode | guest 文件效果 | 网络 |
|---|---|---|
| `read-only` | workspace 以 `:ro` 挂载到 `/work` | 默认关闭 |
| `workspace-write` | workspace 以读写挂载到 `/work` | 默认关闭 |
| `danger-full-access` | 不进入 VM（由调用方直通） | — |

## 已知边界

- guest 根文件系统、`/tmp` 是每次命令独立的可写层，退出后丢弃；策略语义针对宿主机文件效果。
- `ShellExecSpec.workdir` 必须在 `sandboxPolicy.workspaceRoot` 内，否则拒绝执行。
- 只提供 bash shell；PowerShell 工具由 patch 禁用。
- 模型可见文件路径从宿主机路径切换为 Linux `/work` 视图；文件工具仍在宿主机路径上工作，二者通过 workspace mount 保持一致。

## 测试

```sh
npm run check       # typecheck + 单元测试 + build
npm run test:e2e    # 可选：真实启动 microVM 的冒烟测试
```

## 许可

MIT
