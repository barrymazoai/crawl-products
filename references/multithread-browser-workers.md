# 多站点、浏览器租约与 worker 线程

约束 `crawl-products` 在多个任务、多个 Chrome Profile、Codex In-App Browser 或另一台电脑上运行时的边界。核心规则是两级并发：**多个网站必须拆成多个顶层 worker 线程；每个网站 worker 还可创建一个 Luna high 数据子代理处理离线证据**。旧的"worker 停在 preflight 等协调者派发指令"的调度屏障协议已废除——它本身就是停顿点。

## 浏览器模式与租约身份

- `"extension"`（默认）：`agent.browsers.get("extension")`，保留登录态、代理和本地 Profile；同一个 `extensionInstanceId` 只能安全串行。
- `"iab"`：`agent.browsers.get("iab")`，适合公开站点的任务隔离并发；不继承用户 Chrome 的 Cookie、登录态、Clash 路由或 Profile。

用户明确选择的浏览器模式是硬约束：iab 遇到 challenge/TLS/网络失败必须记录并报告，不得偷偷切到 extension，反之亦然。**同模式重建断掉的 binding 不是切换**，是 `incomplete` 恢复的标准动作。

租约身份以实例 ID 为准：extension 用 `extensionInstanceId`，iab 用 `browserId`（有 `codexAppSessionId` 一并记录）。只有实例 ID 不同才是独立租约；同一实例开多个 tab 仍是同一个租约，不能当成另一台电脑。

## 多网站强制多线程

用户给出两个或更多站点时，协调者必须在开始爬取前拆分站点任务：

1. 每个网站建立一个独立 worker goal 和独立 `outDir`；
2. 每个 worker 在线程内部自行调用所选浏览器模式、建立 binding 和 tab；不得接收或复用父线程的 `browser`/`tab` 对象；
3. 按当前可用并发槽位同时启动尽可能多的网站 worker；网站数超过槽位时分批接续，但不得把它们合并成一个 worker 顺序跑完整生命周期；
4. 每个 worker 独立推进状态机、落盘和恢复，协调者不参与站内步骤调度。

这里的“线程”指 Codex 原生 worker/task，不是同一 JavaScript 进程里的 `Promise.all`，也不是在同一 tab 上并发导航。

- `iab`：每个网站 worker 自建 binding，并记录自己的 `browserId`（有 `codexAppSessionId` 一并记录）。
- `extension`：每个网站 worker 自行调用 extension binding，并记录实际 `extensionInstanceId`；不得从协调者或另一个 worker 传递 binding/tab。
- spawn 使用当前环境提供的 Codex 原生线程或子代理能力；不要因为入口名称不同而退回单线程顺序执行。

并发上限由当前可用 worker 槽位决定。槽位不足表示后续网站等待下一批线程，不表示可以把多网站任务改成单线程架构。

## 一个顶层线程 = 一个网站 = 一个 goal

worker 线程的初始 prompt 就是它的 goal，写成完成契约而不是步骤清单：

```
你的唯一目标：让 <site> 达到三种终态之一，在此之前不得结束回合：
  complete / terminal(带证据) / blocked(点名具体阻塞物)
工作方式：读 <outDir>/state.json，按 crawl-products SKILL.md 的状态机从对应状态继续。
证据落盘后，如有可用并发槽位，创建一个 gpt-5.6-luna/high 数据子代理处理本地文本、图片与语义队列；你负责合并和验收它的结果。
汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume。
```

线程的完整时间线不换手：Preflight A/B/C（模型活跃）→ `await runHarvest()`（阻塞在长调用上，脚本机械爬取）→ 语义队列（模型活跃，无浏览器）→ 验证 → 导出。脚本运行期间线程没有任何理由结束回合或等待外部指令。

**可重入**：每个阶段落盘（state.json、HarvestPlan、checkpoint、证据包、语义队列）。线程死亡（超时、崩溃、被回收）不丢工作——把同一 goal prompt 原样重发，新线程读 state.json 从断点继续。

## 站点线程内的 Luna high 数据子代理

当 `evidence/records.json` 和图片已经落盘、任务存在本地文本或图片处理工作且有可用并发槽位时，站点 worker 可创建一个数据子代理，明确请求 `gpt-5.6-luna` 模型与 `high` reasoning。它适合处理：

- 从本地页面文本中提取 Ingredients、Supplement Facts、用途和剂型证据；
- 逐张读取本地画廊图片，识别 Facts/Ingredients/Label/背标并提取可证明内容；
- 根据证据生成 `form`、`health_function`、`main_ingredients` 的候选语义结果与 trace；
- 对分配给它的非重叠产品 ID 分区做批量数据清洗或标准化。

父 worker 给子代理的任务必须是有界的：提供唯一站点 `outDir`、非重叠产品 ID 或文件清单、目标 schema、taxonomy 与独立结果文件路径。子代理只读原始证据，把建议结果写入独立 staging 文件；不得：

- 获取或操作 browser binding/tab；
- 修改 `state.json`、`harvest-result.json`、`checkpoint.json`、`evidence/records.json` 或其他引擎独占产物；
- 与父 worker 同时写 `semantic-queue.json` 或正式导出文件；
- 自行宣告站点 complete、跳过验证门或调用正式接口。

父 worker 始终是站点 owner：检查子代理输出的证据引用与 schema，用 `semanticQueue.applySemanticOutcome()` 等正式接口合并，再继续 Tier 1+2+3 验证。子代理失败、超时或槽位暂不可用时，父 worker 从落盘状态恢复或等待下一可用槽位，不得丢弃该站点。

调度优先级：先保证多个网站 worker 同时推进；尚有空闲槽位时，再由处于离线数据阶段的网站 worker 启动 Luna high。子代理结束后释放的槽位立即用于待启动网站或下一份有界数据任务。

## 协调者职责

1. **启动与补位**：为每个网站建立独立 worker；槽位释放后启动下一批待处理网站。站点 worker 自己管理其 Luna high 子代理；
2. **轮询**各线程的 `state.json` 与产物时间戳；
3. **踢一脚**：某线程状态长时间不动或线程已死 → 原样重发它的 goal prompt。不发送任何"下一步做什么"的指令——下一步由 state.json 决定。

收货规则：协调者不信任线程的自我声明，接受 complete 前必跑 `verify.verifyRunArtifacts(outDir)`；审计 fail 就把问题清单连同 goal 重发给线程。任一站点未到终态，批次不得汇报完成或生成正式批次导出。

## 执行面故障的分级恢复

| 故障 | 信号 | 恢复动作 |
|---|---|---|
| tab 污染 | 超时、截图空白、`discardTab` | `replaceTaintedTab()` 换新 tab，同一 binding 内重试一次 |
| 单页 target 反复崩溃 | 同一商品页连续关闭/超时 | 换 tab 重试一次；仍失败 → 该 **URL** 记 failed 终态（带尝试史），继续其余商品 |
| binding 丢失 | `tabs.new()` 也失败 | 置 binding 为空 → 重新 `agent.browsers.get(browserMode)` → 新 tab → `runHarvest(..., { resume: true })` |
| 接口缺失 | 如 iab 无 `tabs.content` | 能力差异，非故障；引擎自动降级为顺序提取，禁止判 terminal 或换浏览器模式 |
| IAB 平台拒绝访问 | `iab_site_safety_policy_rejected_navigation` 等 | 用户长期授权的唯一换模式场景：降级 `extension` 继续，记入 worker-notes；批次中此类站点进入 extension 顺序队列（单租约，逐站跑） |
| 线程死亡 | state.json 停滞、任务无响应 | 协调者重发 goal prompt，重入线程从磁盘续 |

以上全部是执行面问题：不得写成站点 unavailable，不得把剩余 URL 转成"待复核"，不得覆盖已学 profile。**反例（禁止重演）**：某次实验中 worker 因第 9 个商品页 target 反复关闭，把整站判为 terminal 并跳过了其余全部工作——正确动作是该 URL 记 failed 后继续第 10 个商品、跑完语义队列与审计。页面级访问错误的分类（challenge/TLS/HTTP）见 [site-outcomes-and-handoffs.md](site-outcomes-and-handoffs.md)。

## 顺序纪律

- 同一个 tab 上永不并发：不对同一 tab 使用 `Promise.all` 混合导航、截图、点击、CDP 或 Network 读取。
- 未知站点视觉首遍、代表详情验证、变体逐状态记录始终顺序执行。
- `runHarvest()` 内部详情提取默认顺序（小批次 + 单 tab）；后台并行读取仅限已验证 profile、无交互字段且用户明确接受成本时。
- 同一运行时持有多个租约的 binding 时，可在一个进程内并行运行多个 `runHarvest()`（每租约一个），互不共享 tab。

## 验收口径

"跑 10 个"表示 10 个真实详情 URL 各自拿到完整证据包并通过语义与验证门，不是枚举 10 个列表卡片。10 个不代表全站：目录未耗尽就是 `incomplete`，只能 resume 或按用户成本上限明确停在 `inventory_partial`，不得生成正式 `products.json`。

## 结束和交接

线程结束前 finalize 自己的 tab，不留研究用临时 tab。报告区分：线程 complete（过审计）、incomplete（附 resume 入口）、terminal（附证据）、blocked（点名阻塞物）、以及环境缺口（如没有第二个独立租约）。
