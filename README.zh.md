<h1 align="center">DSH Computer</h1>

<p align="center">
  <strong>一个不会拿“刚才看到的屏幕”当成“现在仍可操作”的 macOS Computer Use Driver。</strong><br />
  <sub>有界 Accessibility 观察 &bull; 原生窗口视觉 + Set-of-Mark &bull; 过期 opaque ref &bull; 宿主审批 &bull; 动作回执</sub>
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
           ▼ observation + opaque ref，只属于一个 Agent，最长 30 秒
       ┌──────────────────────────────┴──────────────────────────────┐
       ▼                                                             ▼
computer_visual_observe                                      computer_act
  只截明确编号的窗口                                            解析一个 ref
  原生 PNG + 像素校验                                           重新核验身份
  AX Set-of-Mark 覆盖                                           策略需要时只询问一次
  交给 DSH 图片附件                                             执行一个动作
       │                                                             │
       ▼                                                             ▼
当前支持图片的模型收到窗口附件                              confirmed | unknown | rejected | failed
```

视觉观察和动作共用同一把 observation 互斥锁。视觉读取不会消耗 ref；被接受或可能已经执行的变更动作会消费整次 observation。

```text
computer_act
  只在该 Agent 的作用域内解析 ref
  重新观察 App/进程/窗口/目标
  拒绝过期、重绑或密码框目标
  确定性高风险目标只向所属用户询问一次
  执行一个绑定后的动作
           │
           ▼
回执：confirmed | unknown | rejected | failed
  + 可获得时附动作后观察
```

首个纵向切片刻意不做设置面板，只提供 5 个 headless 工具，以及一套供 `dsh-qa` 复用的 Cordis Driver 服务。

## 工具

| 工具 | 契约 |
| --- | --- |
| `computer_observe` | 有界读取一个 macOS App/窗口的 Accessibility 树，返回 opaque ref、指纹和过期时间。 |
| `computer_visual_observe` | 只截取新鲜 observation 绑定的明确编号窗口，做像素校验，把有界 AX Set-of-Mark 编号烙入图片，再通过 DSH 附件交给当前这一路支持图片的模型。 |
| `computer_visual_act` | 对同一份截图的附件图像像素执行 `click`、`drag` 或 `scroll`；必须先经宿主批准，工具只用受信任的附件几何信息把附件像素换算成原生像素，不接受模型提供的缩放或原生坐标。 |
| `computer_act` | 对一个新鲜 ref 执行安全的 `click`、`focus`、`type` 或 `key`；每次动作前都重新核验身份。 |
| `computer_evidence` | 返回交互会话、Accessibility 与录屏就绪状态，Helper executable/bundle/signing/process/caller/resolution 身份，以及当前 Agent 自己的近期 AX/视觉动作回执。 |

模型参数里没有 Agent id、AX path、PID lease，也没有让模型自己决定的 `sensitive` 开关。实时 Agent 身份由宿主提供；原始 AX 定位路径不会离开 Driver。

`computer_visual_observe` 只接受 `observation_id` 和可选 `max_marks`（1–200，默认 80），不接受 path、App、窗口、坐标、动作 ref 或审批参数。任何截图发生前都会精确检查 request header 对应的 provider/model route；附件/LLM 服务缺失、route 未知或文本模型都会明确失败，而且不会影响 `computer_observe`。工具 JSON 只包含持久附件元数据、原生/附件尺寸与缩放、编号 → opaque ref/source index 映射，不含路径、base64 或截图 byte buffer。DSH 即使规范化或缩小附件，编号也已经烙在图里。

`computer_visual_act` 接受 `op`、`observation_id`、`capture_sha256`、`point`；`op=drag` 另需 `to`，`op=scroll` 另需 `direction`/`amount`。`point`/`to` 是模型看到的交付附件图像像素。工具只使用 `computer_visual_observe` 保存的受信任附件几何信息换算原生像素，不接受调用方传入的缩放或原生坐标，也不接受 App、窗口、路径、ref、审批、Agent id 或任何图像理解结果作为模型参数。每个视觉动作都按 AX-opaque 未知目标处理，因此一律要求宿主审批，并在审批前后重新截图/核验，派发后回执为 `unknown`——不会 `confirmed`，也不应盲目重试。

## 安全与结果语义

- 观察按 `exec.agent.id` 隔离；没有实时 Agent 身份的工具调用直接拒绝。
- 锁屏、登录窗口、非控制台或无法确认的桌面会话会在观察、截图或动作前 fail-closed；Helper 不会唤醒、解锁或激活 App。
- ref 随机、opaque、只在内存保存，1–30 秒自动过期。
- 一次观察只允许一次可能产生变更的动作；动作被接受或结果不确定后，该观察下的所有 ref 立即失效，Agent 必须重新观察。
- 动作前精确比较 bundle id、PID、启动身份、窗口身份、role/subrole、name、identifier、frame 和安全角色。
- 实时 AX name/identifier 语义命中删除、资金、发送、发布或分享的点击，`Return`/`Enter` 提交键，以及明确导航白名单之外的按键组合，都需要宿主向所属用户展示上下文并取得一次性的 `allowed-once`。安全 focus/导航不弹审批；模型无法传入或伪造审批参数。
- 审批绑定实时 Agent/tool call、observation fingerprint、action digest、风险类别、opaque ref digest 和单请求 nonce。Driver 在询问前、批准后各重新观察一次；目标变化、过期或 scope 被销毁时，该次批准会被消费，但绝不下发动作。
- 密码框输入仍然永久拒绝，不能通过审批放行。
- 输入成功送达不等于用户可见结果成功。无法证明界面效果时返回 `unknown`。
- 点击只有在同一个重新核验通过的目标出现动作特定 value 变化时才会 `confirmed`；目标消失、替换、移动或只是获得焦点都仍是 `unknown`。
- 如果动作可能已经送达后传输中断，回执是 `unknown`，不会假装成 `failed`，从而诱导盲目重试。
- 所有原生请求支持取消；Agent 作用域或插件卸载时会清掉对应进程、观察与引用。
- 多个 Agent 等待同一次首次 Swift 构建时可以独立取消；Agent A 不会中断 Agent B。只有最后一个等待者离开或插件卸载时，才终止共享编译进程。
- 声明中的 `global-hook` 只用于监听 `agent/disposed` 并清理该 Agent 的状态；插件不会读取或改写 Agent 消息。

### 可信宿主边界

短命 Helper 使用普通 stdin/stdout JSON 协议。原生 approval grant 校验只是可信的同一用户 DSH host → plugin → Helper 链路内的 defense-in-depth，并不会以密码学方式认证调用方。公开发行前必须增加认证 IPC/XPC，或等价的签名宿主约束，才能把 Helper 当成抵御同一 macOS 用户下其他进程的安全边界。

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

当前 `contractVersion` 为 `5`。v3 新增了 `scroll` 动作；v4 让证据对截断保持诚实（`computer_evidence` 现携带 `receipts_total`/`receipts_dropped`/`receipts_returned`/`bounded`），将观察淘汰改为 TTL 优先而非按数量，并把每个未标记的 Set-of-Mark 目标都写入 `omitted`。v5 新增面向 AX-opaque 自定义控件的坐标回退 `computer_visual_act`：`computer_visual_observe` 会保存按 PNG SHA-256 绑定的截图几何信息，DSH 工具用受信任的附件几何把附件像素换算成原生像素，Driver 在要求宿主审批前后都会重新截图并核验同一窗口，然后才派发 `click`/`drag`/`scroll`。视觉派发回执一律是 `unknown`，绝不写成 `confirmed`；消费者应重新观察来判断效果，且不得盲目重试 `unknown`。Evidence 现在从同一个有界回执环返回类型化的 AX/视觉回执联合，视觉动作不会从 `computer_evidence` 中消失。省略原因词汇表：`mark-budget-exceeded`、`static-label`、`target_has_no_frame`、`target_outside_captured_window`、`stale_target: …`。后续消费者应先判断版本，再依赖新增字段。

观察保留还按 Agent 作用域做字节预算（32 MiB 序列化负载）：新观察会超出预算时，先淘汰最旧的 TTL 有效观察——同样以 `OBSERVATION_EVICTED` 报告——且最新一次观察永不被淘汰。

## 本地安装

这个候选版本刻意只做本地工程：尚未发布，也不会安装任何 App 到 `/Applications`。

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-computer
dsh web
```

Swift Helper 源码随插件打包。运行时解析顺序固定为：显式 `DSH_COMPUTER_HELPER` override、下方固定本地 App、最后才是 staging 到内容寻址缓存并用固定开发 code identifier 重新 ad-hoc 签名的开发构建；SwiftPM 工作树产物绝不会被原地执行。显式 override 与开发构建都会如实报告 `identityStable: false`。

如需稳定的本机 TCC 身份，签名证书必须由你明确选择，并显式运行安装脚本：

```sh
security find-identity -v -p codesigning
pnpm run helper:install-local -- --identity "<证书完整名称或 SHA-1>"
```

脚本会组装并验证 `~/Library/Application Support/ZSeven/DSH Computer/DSH Computer Helper.app`，固定 bundle id 为 `io.github.zseven-w.dsh-computer.helper`。安装依赖、激活、构建、测试、打包和发布都不会自动调用它；它也不会替你选证书、打开系统设置或申请 Accessibility/Screen Recording。npm 包只带脚本与 Swift 源码，不会带入本机签名 `.app`。

观察 UI 前，macOS 必须存在已解锁的交互式控制台会话，并给**实际路径对应的 DSH Computer Helper**授予 Accessibility；截图则要给同一个 Helper 单独授予 Screen Recording。`computer_evidence` 会报告会话可用性/已知锁定状态、两项 TCC preflight 布尔值、实际 executable/bundle/signing 身份、Helper PID/PPID 和直接拉起它的 DSH/Node caller context。所有状态检查都不会弹权限框；`interactiveSessionAvailable: false` 也可能表示信号无法确认，TCC 布尔值本身则不能区分“已拒绝”和“尚未决定”。

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
- 当前桌面必须已解锁且交互可用。读路径前后以及 mutation 前都会复查锁屏变化；登录窗口持有会话时，后台自动化会被拒绝。
- 原生窗口截图是独立的多模态观察路径，不是坐标动作路径；首版仍没有 OCR、坐标点击、滚动、拖拽、剪贴板自动化和完整 IME 模拟。
- 视觉观察要求 AX 暴露明确窗口号/frame、实际 Helper 身份拥有录屏权限、DSH 附件服务已挂载，且当前精确模型 route 明确声明支持图片。近黑/透明截图会被像素校验拒绝；近白/近纯色截图会保留并携带 warning classification。
- `type` 通过可写 Accessibility value 完成，不等同于自然键盘或输入法输入。
- 部分 App 不完整暴露 AX name、identifier、frame、窗口号或 action；缺少强启动身份时，动作会 fail-closed。
- 确定性风险分类只能使用 App 实际暴露的 AX 语义。没有标签的自定义控件无法仅凭 AX 证明其是否有破坏性；应结合视觉观察理解上下文，并把它视为当前安全边界，而不是保证。
- npm 候选版不预置编译或本机签名的 Helper。显式本地脚本可以在一台开发机上建立证书签名的稳定身份；公开分发仍需要 Developer ID Application、Hardened Runtime、时间戳、公证、staple，并从真实 tarball 重新验收。
- 本地门禁已验证策略、身份、打包和原生协议；当前本地候选版尚未配置 CI/发布自动化。多屏、Spaces/Stage Manager、焦点争抢、中文 IME、长时间运行，以及真正授予 TCC 后的动作链仍未验证。

## 许可证

[MIT](./LICENSE)
