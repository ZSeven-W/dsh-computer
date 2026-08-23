<h1 align="center">DSH Computer</h1>

<p align="center">
  <strong>一个不会拿“刚才看到的屏幕”当成“现在仍可操作”的 macOS Computer Use Driver。</strong><br />
  <sub>有界 Accessibility 观察 &bull; 过期不复用的 opaque ref &bull; 动作前实时身份核验 &bull; 确定性安全策略 &bull; 动作回执</sub>
</p>

<p align="center">
  <sub>包名：<code>@zseven-w/dsh-computer</code> &middot; 本地候选版本：<code>0.1.0-rc.1</code> &middot; 运行环境：macOS + Node.js <code>&gt;=24.11.0</code></sub>
</p>

<p align="center">
  <a href="./README.md">English</a> &middot; <a href="./README.zh.md"><b>简体中文</b></a>
</p>

## 为什么还要做一个 Computer Use？

刚才看见一个按钮，不代表现在还有权点击它。窗口会移动，App 会重启，PID 会复用，动态界面会重排子节点，另一个 Agent 也可能同时在操作。DSH Computer 把每次观察当成一张短期能力票据，而不是一包长期有效的坐标。

```text
computer_observe
  显式/前台 App + 显式/聚焦窗口
  bundle id + PID + 启动身份
  窗口号（或复合身份）
  role + name + identifier + frame
           │
           ▼ opaque ref，只属于一个 Agent，最长 30 秒
computer_act
  只在该 Agent 的作用域内解析 ref
  重新观察 App/进程/窗口/目标
  拒绝过期、重绑、密码框或确定性高风险目标
  执行一个安全动作
           │
           ▼
回执：confirmed | unknown | rejected | failed
  + 可获得时附动作后观察
```

首个纵向切片刻意不做设置面板，只提供 3 个 headless 工具，以及一套供 `dsh-qa` 复用的 Cordis Driver 服务。

## 工具

| 工具 | 契约 |
| --- | --- |
| `computer_observe` | 有界读取一个 macOS App/窗口的 Accessibility 树，返回 opaque ref、指纹和过期时间。 |
| `computer_act` | 对一个新鲜 ref 执行安全的 `click`、`focus`、`type` 或 `key`；每次动作前都重新核验身份。 |
| `computer_evidence` | 返回 Helper/权限就绪状态和当前 Agent 自己的近期回执。 |

模型参数里没有 Agent id、AX path、PID lease，也没有让模型自己决定的 `sensitive` 开关。实时 Agent 身份由宿主提供；原始 AX 定位路径不会离开 Driver。

## 安全与结果语义

- 观察按 `exec.agent.id` 隔离；没有实时 Agent 身份的工具调用直接拒绝。
- ref 随机、opaque、只在内存保存，1–30 秒自动过期。
- 一次观察只允许一次可能产生变更的动作；动作被接受或结果不确定后，该观察下的所有 ref 立即失效，Agent 必须重新观察。
- 动作前精确比较 bundle id、PID、启动身份、窗口身份、role/subrole、name、identifier、frame 和安全角色。
- 密码框输入始终拒绝。
- 删除、资金、发送/发布/分享等语义由 Node 与 Swift 两层确定性策略共同拒绝。`key` 只允许明确的导航白名单；包括 `Control-J`/`Control-M` 在内的可打印快捷键全部拒绝，模型无法绕过。
- 在宿主提供审批流之前，`Return`/`Enter` 提交键全部封死，因此 `type → Return` 不能把安全文本输入变成未经审核的发送、命令或提交。
- 输入成功送达不等于用户可见结果成功。无法证明界面效果时返回 `unknown`。
- 点击只有在同一个重新核验通过的目标出现动作特定 value 变化时才会 `confirmed`；目标消失、替换、移动或只是获得焦点都仍是 `unknown`。
- 如果动作可能已经送达后传输中断，回执是 `unknown`，不会假装成 `failed`，从而诱导盲目重试。
- 所有原生请求支持取消；Agent 作用域或插件卸载时会清掉对应进程、观察与引用。
- 多个 Agent 等待同一次首次 Swift 构建时可以独立取消；Agent A 不会中断 Agent B。只有最后一个等待者离开或插件卸载时，才终止共享编译进程。
- 声明中的 `global-hook` 只用于监听 `agent/disposed` 并清理该 Agent 的状态；插件不会读取或改写 Agent 消息。

当前版本只会拒绝高风险动作，还没有审批流程。

## 给 dsh-qa 的 Driver Contract

插件通过 Cordis 提供 `zsevenComputerDriver` 服务，并导出结构化 TypeScript 契约：

```ts
import {
  COMPUTER_DRIVER_SERVICE,
  type ComputerDriver,
} from '@zseven-w/dsh-computer/driver'

ctx.inject([COMPUTER_DRIVER_SERVICE], (driverCtx) => {
  const driver = driverCtx[COMPUTER_DRIVER_SERVICE] as ComputerDriver
  // scopeId 必须来自可信的实时 Agent/session，不能来自模型参数。
})
```

当前 `contractVersion` 为 `1`；后续消费者应先判断版本，再依赖新增字段。

## 本地安装

这个候选版本刻意只做本地工程：尚未发布，也不会安装任何 App 到 `/Applications`。

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-computer
dsh web
```

Swift Helper 源码随插件打包。开发 checkout 由 SwiftPM 构建；打包安装后，首次原生请求也可以把同一份源码惰性构建到当前用户缓存。`DSH_COMPUTER_HELPER` 只用于开发或受控部署时指定明确的可执行文件。

观察 UI 前，macOS 必须认为运行 Helper 的进程拥有 Accessibility 权限。`computer_evidence` 只报告当前状态，不会打开系统设置，也不会声称权限已授予。

## 开发与验收

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm build
pnpm run smoke:pack
```

验收包含 Node 单测、Swift 纯策略/身份测试、真实 Swift Helper 构建与协议 status 握手，以及 `npm pack` → 全新目录 `npm install`。在 macOS 上，全新安装会从包内源码惰性构建自己的 Helper，只运行 status 和一次有界观察（绝不执行动作），并等待所有子进程收敛。smoke 同时断言 `node_modules` 中没有任何 `@deepseek-ai/*` 包。

## 当前边界

- 只支持 macOS。包在其他系统仍可安装，使 DSH profile 能明确报告“不支持”，而不是启动即崩；原生动作不可用。
- 首版只做 Accessibility 语义操作：没有截图视觉、OCR、坐标点击、滚动、拖拽、剪贴板自动化和完整 IME 模拟。
- `type` 通过可写 Accessibility value 完成，不等同于自然键盘或输入法输入。
- 部分 App 不完整暴露 AX name、identifier、frame、窗口号或 action；缺少强启动身份时，动作会 fail-closed。
- 本地候选版不签名、不公证，也不预置编译好的 Helper。
- CI 已验证策略、身份、打包和原生协议；多屏、Spaces/Stage Manager、焦点争抢、中文 IME、长时间运行，以及真正授予 TCC 后的动作链仍未验证。

## 许可证

[MIT](./LICENSE)
