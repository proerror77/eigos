# 用户授权后操作第三方微信小程序：开源方案调研

调研日期：2026-10-22。目标：EIGOS 使用用户本人已登录的微信会话，操作第三方线上小程序，不依赖商家提供项目源码或把用户加入开发者名单。

本次只核查一手文档、源代码、发布记录与问题反馈。没有安装执行器、连接或解锁设备、登录微信、注入进程、提交订单或付款。文中的推荐是工程选型判断，所有候选均未完成 EIGOS 目标小程序的运行验收。

## 结论

存在比 wxa-runner 更贴近目标的开源路径。优先验证 **用户 Android 真机 + Midscene + EIGOS 设备连接器**：在真实微信界面上操作，账号会话保留在用户设备；EIGOS 继续负责业务规划、任务授权、取消与结果验收。选择 Midscene 的理由是 TypeScript 集成、视觉定位、单步动作及执行报告，不能据此宣称其微信小程序成功率已经优于其他方案。

**Open-AutoGLM** 适合作为中文手机任务的端到端对照。**Appium / uiautomator2** 可用于已验证页面的确定性操作。**WMPFDebugger + CDP** 确实提供真实桌面小程序的调试路径，但需要运行时注入、微信版本适配及额外隔离，宜作为研发诊断支线。

本次没有找到经验证、一次普通微信 OAuth 授权后即可通用控制任意第三方小程序的开源业务连接器。以下方案的“授权”主要指设备控制授权及用户已有的微信/商家登录会话；这不自动取得微信官方接口资格、商家的合作授权或订单/付款许可。

## 证据如何阅读

- **文档声明**：项目作者说明支持什么，不等于本次复现成功。
- **源码证据**：能定位到设备、动作、权限或失败行为的实现，不等于目标业务已跑通。
- **问题反馈**：具体使用者报告的兼容问题；不能外推为所有设备必然失败。
- **运行验收**：必须在选定设备、微信版本和目标小程序上，取得真实操作与独立结果读回。本次没有这一层证据。

## 核心候选

| 方案 | 实际控制对象 | 是否依赖商家源码 | 对 EIGOS 的定位 | 关键限制 |
| --- | --- | --- | --- | --- |
| [Midscene](https://github.com/web-infra-dev/midscene) | ADB 连接的 Android 真机；另有 iOS WDA 和桌面后端 | 视觉操作路径不依赖 | 首选验证，封装单步设备能力 | 需 GUI 模型；小程序身份、权限、业务结果仍由 EIGOS 核验 |
| [Open-AutoGLM](https://github.com/zai-org/Open-AutoGLM) | 真实手机上的截图与触控 | 手机 UI 路径不依赖 | 中文手机任务的端到端对照 | 通用 Agent 需要收敛权限；已有微信小程序广告阻塞反馈 |
| [Mobilerun Core / Core Local](https://mobilerun.ai/core/) | ADB 或 Portal 连接的 Android，纯设备 API | 设备 UI 路径不依赖 | 需要无模型设备层与 UI 树时的备选 | Python 边车；取消契约待补；微信空元素树反馈；源码仓库当前 404，但 PyPI 源码包可读 |
| [Appium UiAutomator2](https://github.com/appium/appium-uiautomator2-driver) / [openatx uiautomator2](https://github.com/openatx/uiautomator2) | 已安装 Android App、原生 UI 与截图 | 原生 UI 路径不依赖 | 已验证界面的稳定操作底座 | 元素树不保证覆盖所有小程序页面；不可假设生产微信开放 WebView 调试 |
| [Mobile MCP](https://github.com/mobile-next/mobile-mcp) | Android / iOS 设备，截图、元素、触控 | 设备 UI 路径不依赖 | 快速连接既有 MCP Agent 的备选 | MCP 外层 Apache-2.0；默认底层 MobileCLI 是 FSL-1.1，需按组件核对 |
| [WMPFDebugger](https://github.com/evi0s/WMPFDebugger) + [miniapp-cdp-mcp](https://github.com/zhizhuodemao/miniapp-cdp-mcp) | 真实 PC 微信中运行的小程序，CDP 调试会话 | 启动流程不要求项目文件 | 研发诊断与专项兼容验证 | 注入、版本依赖、较大调试权限；没有现成业务授权与验收能力 |

### Midscene：最适合先嵌入现有 Worker

审查代码快照：`72020c10e291e3c727943c9849d86a2a7b615131`。查询到最新正式发布为 [v1.16.5，2026-10-22](https://github.com/web-infra-dev/midscene/releases/tag/v1.16.5)；发布存在不等于本次安装验证。

- [Android 指南](https://midscenejs.com/platforms/android)及 [AndroidAgent 源码](https://github.com/web-infra-dev/midscene/blob/72020c10e291e3c727943c9849d86a2a7b615131/packages/android/src/agent.ts)表明，它连接实际 ADB 设备，提供 Node/TypeScript SDK，不需要把小程序移植到浏览器。
- [Agent API](https://midscenejs.com/reference/)包括 `aiTap`、`aiInput`、`aiQuery`、`aiAssert` 与多步骤 `aiAct`，并生成含截图与动作的报告。[源码](https://github.com/web-infra-dev/midscene/blob/72020c10e291e3c727943c9849d86a2a7b615131/packages/core/src/agent/agent.ts)含 `aiAct` 的 `abortSignal` 和执行清理入口。取消能否及时停止具体设备操作，还需适配层测试；不能撤销已经发出的业务动作。
- [应用映射](https://github.com/web-infra-dev/midscene/blob/72020c10e291e3c727943c9849d86a2a7b615131/packages/android/src/appNameMapping.ts)含微信 `com.tencent.mm`。这是启动应用的证据，不能作为所有微信小程序兼容性的证明。
- 框架根 [LICENSE](https://github.com/web-infra-dev/midscene/blob/72020c10e291e3c727943c9849d86a2a7b615131/LICENSE) 为 MIT；模型权重、模型服务与依赖组件的条件需分别核对。
- `agentFromAdbDevice()` 未指定设备时会选择第一个设备。EIGOS 必须显式绑定已授权的设备 ID，不能沿用自动选择。示例中的自动同意权限弹窗也不应成为 EIGOS 的默认行为。

建议以单动作 API 为主，将“打开目标小程序”“查询商品”“提取详情”等限定业务步骤映射到已验证的 UI 行为。不要把不受约束的整段购买目标交给 `aiAct` 后只读取最终文字。视觉断言可辅助核对页面，但独立业务验收仍由 EIGOS 完成。

[iOS 指南](https://midscenejs.com/platforms/ios)说明可以通过 WebDriverAgent 控制 iPhone；其部署、签名及设备配置与 Android 不同。如果首批用户只有 iPhone，应单独验证这条路径，而不能把 Android 测试结果迁移为 iOS 支持承诺。文档中的美团 App 演示也不能用作微信小程序专项证明。

### Open-AutoGLM：中文任务对照组，单步不等于执行前审批

审查快照 `86f55382982fb054e8fc98ca80609dff8a2cdc3c`，最近提交记录为 2026-03-06；本次 GitHub Releases 查询未列出 release。[README](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/README.md)说明通过 ADB 截图和触控操作 Android，中文输入通常需要 ADB Keyboard，模型服务另行提供，并列出微信及人工接管回调。当前文档也有 iOS/WDA 路径，并链接 Midscene 的 AutoGLM 接入，因此可以只评估其模型，而不必完整引入 Python Agent。

两个直接影响集成的事实：

- [`PhoneAgent.step()`](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/phone_agent/agent.py)内部会执行动作，不是仅生成待批准动作。[`_handle_tap()`](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/phone_agent/actions/handler.py)只有在模型动作带 `message` 时调用敏感操作确认；不能当作对所有下单和付款都强制生效的关卡。
- [issue #166](https://github.com/zai-org/Open-AutoGLM/issues/166)在核查时仍 open：用户报告进入微信小程序后无法跳过广告、未完成用户中心信息读取。这证明有人尝试了该场景，也揭示了失败方式，不是专项成功案例。

代码 [LICENSE](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/LICENSE) 为 Apache-2.0，README 同时有研究学习用途表述并链接[使用规范](https://github.com/zai-org/Open-AutoGLM/blob/86f55382982fb054e8fc98ca80609dff8a2cdc3c/resources/privacy_policy.txt)。模型及产品化条件应核对具体材料，不能只看许可证徽标。

### Mobilerun：更适合借用纯设备 Core

`droidrun/droidrun` 当前重定向至 [droidrun/mobilerun](https://github.com/droidrun/mobilerun)，框架审查快照 `301856138c6edeb2ae692bfab85b279ace520e59`，MIT，[v0.7.0](https://github.com/droidrun/mobilerun/releases/tag/v0.7.0) 于 2026-10-14 发布。框架有 UI 树、截图、vision-only、事件与结构化输出；拆分出的 [Core](https://mobilerun.ai/core/) 不包含模型/Agent 循环，更符合 EIGOS 保留业务决策的方向。

本轮静态读取以下 PyPI sdist，在内存检查源码，未安装或执行：

| 发布物 | 版本与日期 | 许可材料 | 源码状态 |
| --- | --- | --- | --- |
| [mobilerun-core](https://pypi.org/project/mobilerun-core/1.10.0/) | 1.10.0，2026-10-20 | 元数据及 pyproject 声明 Apache-2.0；所读源码包未包含独立 LICENSE | 官方列出的 GitHub 地址当前 404；PyPI 源码包可取得 |
| [mobilerun-core-local](https://pypi.org/project/mobilerun-core-local/0.7.0/) | 0.7.0，2026-10-20 | 源码包包含 MIT LICENSE | 官方列出的 GitHub 地址当前 404；PyPI 源码包可取得 |
| [mobilerun-sdk](https://pypi.org/project/mobilerun-sdk/5.5.0/) | 检查 5.5.0 | PyPI 声明 Apache-2.0 | Core 1.10.0 依赖约束为 `>=5.5.0,<6` |

Core / Core Local 源码包 SHA-256 分别为 `3b869511da508d455e9c2d635c0e525d7afa7a989e541c9df22998d47b0d76ce` 和 `e1440e2b0529cd0361d5c9b07271bf6859929ddb236c7a241f4c9eab48806faf`。源码包可审计，但不能据此宣称 GitHub 开发历史和问题追踪可用。

Core 为同步 Python facade，Core Local 为异步 Python 驱动；Python 3.11–3.13，TS EIGOS 需要子进程或本机 RPC。核查 `mobilerun_core/device.py`、`connection/framework.py`、Core Local 的 `driver/android/adb.py` 与 `driver/portal_http.py` 后确认：可以明确绑定设备 serial/endpoint，提供 `ui()`、`screenshot()`、`tap()`、`type()`、`swipe()` 和前台 App 查询；本地 backend 不要求托管云服务。

同时存在需要自行处理的边界：没有统一 `cancel()`/AbortSignal 契约，点击/输入不全受统一 timeout 约束；`stop_app()` 是强制停止 App，不能等同任务取消；`ui_with_recovery()` 超时会按 Home，不是纯读取；HITL 主要覆盖安装/卸载，不能识别普通点击中的付款含义。[工具分层说明](https://github.com/droidrun/mobilerun/blob/301856138c6edeb2ae692bfab85b279ace520e59/docs/sdk/base-tools.mdx)

[Portal issue #142](https://github.com/droidrun/mobilerun-portal/issues/142)在核查时仍 open，报告 vivo Android 13/微信 8.0.74 的无障碍树为空，并有三星同类反馈。不能外推为所有手机失败；但需要测试视觉降级，不应把“可读 UI 树”当作微信小程序的可靠前提。

推荐条件：若需要纯设备层、UI 树及多 backend，并接受 Python 边车，可以评估 Core；目前先验证 Midscene，集成成本更贴近我们的 TypeScript 工程。这里比较的是接口与工程成本，不是实测成功率。

### Mobile-Agent / GUI-Owl：保留为模型与研究基线

[Mobile-Agent v3.5](https://github.com/X-PLUG/MobileAgent/blob/11cea575561fb7800b5fb6b6cafa56f7a91de11f/Mobile-Agent-v3.5/README.md)的真实手机入口支持 Android/ADB，截图生成动作并执行点击、输入、滑动。审查快照 `11cea575561fb7800b5fb6b6cafa56f7a91de11f`，最近提交记录 2026-07-07；代码 MIT，模型权重和模型服务另核对。

其[包名表](https://github.com/X-PLUG/MobileAgent/blob/11cea575561fb7800b5fb6b6cafa56f7a91de11f/Mobile-Agent-v3.5/mobile_use/packages.py)含微信，但本次所读 README 和[执行脚本](https://github.com/X-PLUG/MobileAgent/blob/11cea575561fb7800b5fb6b6cafa56f7a91de11f/Mobile-Agent-v3.5/mobile_use/run_gui_owl_1_5_for_mobile.py)没有可复核的第三方微信小程序专项验收。AndroidWorld/MobileWorld 指标不能替代这个场景。可用于视觉模型比较，不优先引入另一套完整业务 Agent。

### Appium / uiautomator2：控制底座而非业务 Agent

[Appium UiAutomator2 文档](https://github.com/appium/appium-uiautomator2-driver/blob/master/README.md)支持 macOS/Linux/Windows 宿主和 Android 真机，可指定已安装应用的 `appPackage`，并通过 `udid` 绑定设备、`noReset` 保留应用数据。因此可以把真实微信作为被操作应用，无需第三方小程序代码。WebView/CDP 模式另有前提，不能默认线上微信可用。

[openatx/uiautomator2](https://github.com/openatx/uiautomator2)提供 Python 客户端、设备端 HTTP 服务、截图、UI 层级与元素动作。它适合将已验证页面固化成操作步骤；对于元素树缺失或自绘控件，需要视觉定位或人工交接。两者都不自带 EIGOS 的成员授权、业务计划、支出约束与独立验收。

### Mobile MCP：协议方便，依赖许可不能只看外层

审查代码快照：`c659f8ee34873a832adea7daca9c69172d887e70`。

[README](https://github.com/mobile-next/mobile-mcp/blob/c659f8ee34873a832adea7daca9c69172d887e70/README.md)列出截图、UI 元素、点击、输入等设备工具，支持 Android/iOS 真机。其 HTTP 服务只有配置 `MOBILEMCP_AUTH` 后才要求 Bearer；EIGOS 可优先使用本地 stdio，并额外实现成员与设备绑定。

需要特别区分：主包是 Apache-2.0，但默认的 [MobileDevice 实现](https://github.com/mobile-next/mobile-mcp/blob/c659f8ee34873a832adea7daca9c69172d887e70/src/mobile-device.ts)调用 MobileCLI；[MobileCLI LICENSE](https://github.com/mobile-next/mobilecli/blob/main/LICENSE)为 FSL-1.1，含 Competing Use 限制以及两年后生效的 Apache-2.0 future license。[供应方条款](https://mobilenext.ai/terms)也明确分别列出这些组件。不能把整套默认运行链描述为纯 Apache 开源组件。

README 有 `MOBILEMCP_LEGACY_ROBOT=1` 的旧设备后端选项；本次没有验证它是否完全移除所涉依赖及功能影响。因此将该路线列为备选，产品嵌入前核对实际依赖和适用许可，不在此作商业许可结论。

### 桌面微信：能进入真实小程序，但不是现成生产连接器

[evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger) 的审查快照为 `832b2bb0399d81eda8bad2cea776b68444505287`，最近提交记录为 2026-09-21。项目启动方式是先建立调试桥，再在真实微信中打开小程序；[入口源码](https://github.com/evi0s/WMPFDebugger/blob/832b2bb0399d81eda8bad2cea776b68444505287/src/index.ts)直接通过 Frida 连接 WeChatAppEx 并转发 CDP。由此可以推断该路径不依赖小程序项目源码及开发者工具中的项目身份，具体目标仍待实跑。

- 支持表包含 Windows x64、Linux x64、macOS ARM64；当前 ARM64 表只列 WMPF `269136`，不是覆盖所有微信版本。
- [macOS FAQ](https://github.com/evi0s/WMPFDebugger/blob/832b2bb0399d81eda8bad2cea776b68444505287/FAQ.zh.md)对访问进程受限给出 WeChatAppEx ad-hoc 重签名处理；关闭 SIP 被列为不推荐方案。这不是普通用户只点一次 OAuth 授权的接入体验。
- 当前入口使用全局消息转发并广播到连接客户端，未见该入口实现成员/任务认证和隔离。不能原样作为共享多用户代理。
- 项目采用 GPLv2，并包含从微信开发者工具提取的腾讯代码。需按组成部分核对；MCP 包的 MIT 不会覆盖其下层许可。

[miniapp-cdp-mcp](https://github.com/zhizhuodemao/miniapp-cdp-mcp) 审查快照 `4373a1297dab2efae082ec014ea54122b843ff26`，版本 0.1.6，最近提交记录为 2026-04-22。它提供 AppService/WebView 切换、网络、脚本、断点及 `evaluate_script`，依赖外部工具先开启 CDP。[当前实现](https://github.com/zhizhuodemao/miniapp-cdp-mcp/blob/4373a1297dab2efae082ec014ea54122b843ff26/src/miniapp_cdp/mcp_server.py)没有专门的截图、点击、输入或业务授权接口。CDP 可以扩展，不等于这些能力已交付；原始 JS 求值不适合作为“只读商品查询”的公共工具。

其他桌面候选：

- [chain00x/WMPFDebugger-arm](https://github.com/chain00x/WMPFDebugger-arm)：旧 ARM 分支，最近提交记录 2025-12-11；上游现已有 ARM64，应先核对上游兼容表。
- [JaveleyQAQ/WeChatOpenDevTools-Python](https://github.com/JaveleyQAQ/WeChatOpenDevTools-Python)：支持表主要是旧 Windows 3.9.x 和 Mac x64 3.8.8，最近提交记录 2024-09-15；本次未找到明确 LICENSE，不作为新产品默认基础。
- [Zhong-fangshuo/zhong-wechat-wmpf-debugger](https://github.com/Zhong-fangshuo/zhong-wechat-wmpf-debugger)：作者列出 Windows WeChat 4.1.10/WMPF 19895 验证，具备现代 bridge；仍依赖版本地址表，其 [THIRD_PARTY](https://github.com/Zhong-fangshuo/zhong-wechat-wmpf-debugger/blob/78d158dd7b0f4d161f9bc17070e3d3a0fec2b156/THIRD_PARTY.md)记录复杂的上游许可来源。

## 不满足这次目标的路线

[wxa-runner](https://github.com/open-wxa/wxa-runner) 需要项目文件，真实登录依赖目标 AppID 的开发者身份。[weapp-agent-mcp](https://github.com/Chaixueyuan/weapp-agent-mcp) 和其他 `miniprogram-automator` 包装要求开发者工具中可打开的小程序项目。即使它们有截图、点击、恢复和 MCP 接口，也不能由此变成普通用户访问任意第三方线上小程序的入口。

微信聊天、联系人管理或消息收发项目也不能仅凭“支持微信”列为小程序执行方案。是否覆盖小程序页面，需要独立证据。

## 建议的 EIGOS 接入结构

```text
PA → EIGOS Gateway → Ontology + LLM / Worker
                           ↓ 已授权的业务步骤
                    成员绑定的设备连接器
                           ↓ 单步读取或操作
                  用户 Android → 微信 → 目标小程序
                           ↓ 操作证据与结果读回
                    Observation → 独立验收 → PA
```

这是拟议结构，不是已实现接口。沿用 [Gateway/Worker 边界](../gateway-worker.md)、[PA 接入契约](../integration.md)和[现有单动作连接器](../../packages/capabilities/shopify/connector.ts)。Worker 继续在现有任务存储边界内运行；远端用户设备由连接器接入，不通过复制 SQLite 部署新的远端 Worker。

需要补齐的能力集中在：

1. **成员、设备与会话绑定**：绑定 member、设备 ID、微信会话及可操作小程序；会话凭据保留设备端。设备授权通常比单一小程序更宽，EIGOS 必须自行缩小可派发的动作范围。
2. **同一设备的独占执行**：同一设备同一时刻只执行一个任务；人工接管、任务取消、会话失效后停止后续步骤。微信前台包名都是 `com.tencent.mm`，仅检查包名不能证明仍在获准的小程序中。
3. **动作前核验与人工交接**：GUI 的点击没有通用“只读”语义。首版只支持已验证查询路径；遇到登录、验证码、身份核验、授权弹窗或不明确副作用时交接。不能只靠提示词禁止下单。当前项目禁止真实订单与付款的约束保持。
4. **证据与完成分离**：记录小程序/商家身份、时间、输入、前后截图、操作结果和关联任务。截图需按成员私有保存并最小化传给模型。模型宣告成功或 UI toast 不直接通过业务验收；有供应方接口时独立查询，只有 UI 时经独立页面刷新/订单页查询核验，并说明证据局限。
5. **未知结果恢复**：已经点击的业务动作发生超时后，先查原操作；任务取消不代表外部订单被取消。成员撤销授权后不得继续新的业务步骤。

上述约束不是候选框架自带的完整能力，需由 EIGOS 适配与验证。为这次目标重新搭建一套通用手机 Agent 平台没有必要。

## 最小验证建议

先在一台明确授权的 Android 真机、一个指定版本的微信和一个目标第三方小程序上，对比 Midscene 与 Open-AutoGLM。用户自己完成微信及商家登录；验证任务仅覆盖打开正确小程序、搜索和读取真实商品/服务详情，不创建订单或付款。

第一阶段验收：

- 不提供商家源码、开发者账号或模拟登录数据，实际打开目标线上小程序。
- 由 PA 发起原任务，经 EIGOS 读取业务上下文，再执行设备步骤；结果包含真实来源与时间，并由 PA 读回。
- 对照用户可见页面确认商家、商品/服务、规格、价格和状态；重新打开详情后核对结果。
- 测试取消、用户接管、锁屏/断连、登录失效及异常弹窗；不得在恢复后重复不明操作。
- 记录任务成功率、误操作、人工接管次数、耗时和模型成本，固定设备/微信/小程序/模型版本。首个目标通过后再扩展第二个小程序。

只有这些验证通过，才能将某个具体小程序的某段流程列为可用能力。读取通过仍不代表下单、付款或最终履约已经接通。
