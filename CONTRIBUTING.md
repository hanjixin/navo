# 参与开发

## 环境

- Node.js 22（见 `.nvmrc`），pnpm 10（`corepack enable` 后自动使用 `packageManager` 指定的版本）
- macOS 上跑端到端测试需要系统自带的 `sqlite3`

```bash
pnpm install        # 同时为 Electron 编译 better-sqlite3，并安装 Git 钩子
pnpm dev            # 开发模式（界面热更新；改了 src/main 需要重启）
```

## 常用脚本

| 命令                               | 作用                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm check`                       | 类型检查 + ESLint + Prettier 检查 + 单元测试（提交 PR 前跑一遍）                                    |
| `pnpm lint:fix` / `pnpm format`    | 自动修复 Lint / 格式                                                                                |
| `pnpm test` / `pnpm test:coverage` | Vitest 单元测试（纯逻辑：RPC、快照遮罩、匹配规则、录制步骤…）                                       |
| `pnpm test:e2e`                    | 构建后用 Playwright 驱动 Electron 跑全部端到端套件（本地 mock 模型 / MCP / Langfuse，无需真实密钥） |
| `pnpm test:agent`                  | 用真实模型跑一轮对话（需要 `ANTHROPIC_API_KEY`，或 `PROVIDER=openai-responses OPENAI_API_KEY=…`）   |
| `pnpm dist` / `pnpm test:packaged` | 打包安装包 / 对打包产物做冒烟测试                                                                   |
| `pnpm screenshots`                 | 截取各页面截图                                                                                      |

单个端到端套件可以直接运行，例如 `pnpm build && node e2e/features.mjs`。

## 目录

```
src/main/            主进程：窗口、浏览器、插件、宏、MCP、连接器、工具注册
src/main/agent-host/ Agent 进程（utilityProcess）：deepagents 运行循环、checkpoint、Langfuse
src/preload/         预加载脚本（主窗口 / 浏览器标签页）
src/renderer/        React 界面（Tailwind v4 + radix-ui）
src/shared/          两端共享的类型与 IPC 契约（ipc-contract.ts 是唯一的接口定义）
tests/               Vitest 单元测试
e2e/                 Playwright + Electron 端到端测试与夹具（mock 模型、MCP 服务器）
```

新增 IPC：先在 `src/shared/ipc-contract.ts` 声明，再在 `src/main/handlers.ts` 实现，渲染端用 `call('xxx')` 调用，类型自动贯通。

## 约定

- **提交信息**遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat(agent): …`、`fix(browser): …`、`chore: …`，`commit-msg` 钩子会检查。
- `pre-commit` 钩子对暂存文件执行 ESLint 修复与 Prettier 格式化。
- UI 遵循设计规范：主题色 `#4474F2`、克制的配色、6px 圆角；每个数据视图都要有加载 / 空 / 错误三种状态（`AsyncView`）。
- 密钥一律通过 `src/main/core/secrets.ts`（系统钥匙串）保存，不写入 SQLite 明文，也不返回给渲染进程。

## 发布

更新 `package.json` 版本号后推送 `v*` 标签（如 `git tag v0.2.0 && git push --tags`），`Release` 工作流会构建 macOS / Windows / Linux 安装包并创建草稿 Release。配置仓库 Secrets（`MAC_CERT_P12_BASE64`、`APPLE_ID` 等，见 `.github/workflows/release.yml`）后即可签名；公证需在 `electron-builder.yml` 中把 `mac.notarize` 设为 `true`。
