# Harvest 架构设计（提案，未实施）

> 状态：设计文档，尚未实现。实现后本文档转为架构说明，SKILL.md 相应重写。
> 目标：解决"并发跑一半自己停下"，把动态判断留给模型、机械执行交给脚本，并让每个结论可验证、可审计、可重入。

## 0. 总原则

1. **动态判断归模型，机械执行归脚本。** 模型做站点判定、路径探索、终止契约、语义推断、验证判定；脚本做枚举、提取、落盘、重试、看门狗。
2. **每个结论都带验证痕迹。** 任何"是什么 / 没有什么 / 通过 / 不通过"的结论，必须记录：怎么验的（method）、在哪验的（surface）、看了什么证据（evidence）。无痕迹的结论视为未验证。
3. **写盘为准，内存为快。** 每个阶段落盘产物；线程死了，重入线程从磁盘继续，不从头再来。
4. **终点是"全部到达终态"，不是"全部成功"。** `review`（带完整尝试史的放弃）是合法终态。
5. **考官不能是考生。** 验证者的输入不含生产者的推理和自评。

## 1. 整体流程

```
┌─────────────────────────── 一个 worker 线程 = 一个站点 = 一个 goal ───────────────────────────┐
│                                                                                            │
│  Preflight（模型 + 浏览器）                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────────┐                                  │
│  │ A 要不要做   │ → │ B 路怎么走   │ → │ C 怎么算结束      │ → 合成 HarvestPlan（校验后生效）    │
│  │ 站点判定     │   │ 视觉探索     │   │ 终止契约          │                                  │
│  └─────────────┘   └─────────────┘   └──────────────────┘                                  │
│         │ 卖场/terminal → 带证据结案                                                         │
│         ▼                                                                                  │
│  脚本收割 await runHarvest(plan)（浏览器，长调用，线程阻塞等待）                                 │
│    ENUMERATE 到不动点 → EXTRACT 到队列排空 → 证据包 + 图片落盘 + flags                         │
│    退出三值：complete / incomplete+checkpoint / terminal                                     │
│         │                                                                                  │
│         ▼                                                                                  │
│  验证① 查漏（模型 + 浏览器，抽样）：站上有的，我们抓到了吗 ──不过──► 补 seed，回 harvest          │
│         │ 过                                                                               │
│         ▼                                                                                  │
│  语义队列（模型，无浏览器）：读证据包 + 本地图片 → form/health_function/main_ingredients        │
│    每条出口：enriched / review(原因) / needs_browser(证据缺)                                  │
│         │                                                                                  │
│         ▼                                                                                  │
│  回炉队列（模型 + 浏览器，量小）：补证据 → 回语义队列                                            │
│         │                                                                                  │
│         ▼                                                                                  │
│  验证② Tier1 机械审计 + Tier2 查真 + Tier3 语义对抗 ──不过──► 按四道闸打回对应队列               │
│         │ 全过                                                                              │
│         ▼                                                                                  │
│  严格导出（要求 verification-report.json 存在且 pass）                                        │
│                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Preflight 三步（模型，每步落盘一份产物）

| 步骤 | 回答的问题 | 产物 | 说明 |
|---|---|---|---|
| A | 要不要做 | `entry-decision.json` | 站点身份判定（storefront / multi_brand_retailer / portfolio / terminal），复用 `classifySiteOutcome()`；卖场与 terminal 在此结案 |
| B | 路怎么走 | `route-plan.json` | 视觉首遍：listing seeds、分页动作、详情/画廊/变体 selector、展开动作；代表样本过重放质量门才算完成 |
| C | 怎么算结束 | `termination-contract.json` | 每个 seed 的耗尽信号、外部对账 oracle、预算、重试策略（见 §4） |

三份产物合成 **HarvestPlan**；`runHarvest()` 先 schema 校验，缺任何一项拒绝启动。

## 3. 双契约

### 3.1 HarvestPlan（模型填给脚本的指令）

```jsonc
{
  "site": { "origin": "...", "entryUrl": "...", "browserMode": "iab" },
  "decision": { "kind": "storefront", "evidence": ["screenshot:entry.png"] },
  "route": {
    "listingSeeds": [
      { "url": ".../vitamins", "paginationMode": "click",
        "nextAction": { "selector": "button.load-more" } }
    ],
    "detailProfile": { /* 现有 profile 结构 */ },
    "imageProfile": {}, "variantProfile": {},
    "expandActions": [ /* 详情页展开 accordion/tab 的动作 */ ]
  },
  "termination": {
    "perSeed": [{ "url": ".../vitamins", "exhaustionSignal": "no_new_urls_after_clicks:3" }],
    "fixpoint": { "extraRoundsAfterConverge": 1 },
    "oracles": [{ "type": "collection_count", "expected": 200, "source": "listing header" }],
    "budgets": { "maxItems": 200, "maxPagesPerSeed": 50,
                 "wallClockMinutes": 60, "stallMinutes": 5,
                 "operationIdleMinutes": 5 },
    "retryPerUrl": 2
  }
}
```

### 3.2 EvidencePackage（脚本交回给模型的证据，每商品一份）

脚本不判断，只把判断所需的一切收齐并落盘：

```jsonc
{
  "productUrl": "...",
  "fields": { "title": "...", "description": "...", "directions": "...",
              "ingredients_text": "...",        // 展开动作重放后的全文
              "facts_table": "..." },            // DOM 表格序列化
  "gallery": [
    { "url": "https://cdn/.../front.jpg", "alt": "...", "index": 0,
      "localPath": "evidence/img/abc123.jpg",    // 已下载落盘
      "mime": "image/jpeg", "width": 1600, "height": 1600,
      "factsCandidateRank": 2 }                  // classifyFactsImageCandidate 启发式排序，非结论
  ],
  "coverage": {                                   // §7 缺失证明的原材料
    "gallerySaved": "6/6",
    "domSectionsExpanded": ["Description", "Supplement Facts", "FAQ"],
    "jsonLdCaptured": true
  },
  "flags": []   // 如 ["heading_only_ingredients", "image_download_failed:<url>"] → 回炉队列
}
```

## 4. 脚本引擎 runHarvest()

固定生命周期，无自由裁量：

```
INIT ──► ENUMERATE ──► EXTRACT ──► FINALIZE ──► 退出（三值）
          循环直到      循环直到                   complete / incomplete+checkpoint / terminal
          不动点        队列排空
全程看门狗（三重死线，任一触发都落盘 incomplete + checkpoint，绝不冻结）：
  - stallMinutes：停滞无进度事件；
  - wallClockMinutes：单站总墙钟死线（防大站陷太久拖住整波）；
  - operationIdleMinutes：单次 extract/upgrade 调用的无进展超时（idle deadline，每次进度信号重置，
    防浏览器操作在内部卡死时循环走不到检查点）。超时按 binding_lost 处理，可 resume。
```

**枚举终止（不动点）**：

| 分页方式 | 耗尽信号 |
|---|---|
| link | 下一页链接消失，或指回已访问 URL |
| click | 按钮消失/禁用，或连点 N 次新增 URL 数 = 0 |
| scroll | 连续 M 轮 settle polling 无新卡片 |
| none | Step B 已视觉确认单页，读一次即完 |

全局判据：完整跑一轮所有 seed 后 URL 集合零增长 → 收敛；再跑 `extraRoundsAfterConverge` 轮确认。
收敛后对 oracle 对账（sitemap 计数 / 列表页声明计数 / Shopify products.json）；枚举数 < 声明数 → 不算 complete，差额记录，回探索补路径。

**提取终止（队列排空）**：每个 URL 必达终态之一：`complete`（证据包齐）/ `failed`（重试 retryPerUrl 次后，带原因）/ `excluded`（范围排除，带原因）。失败也是终态，绝不阻塞队列。

**退出后模型的动作是一个 switch，没有自由裁量**：

```
complete   → 进验证①与语义队列
incomplete → 重建 binding（若断）→ resume(plan, checkpoint)
terminal   → 带证据报告
```

## 5. 语义队列（模型，无浏览器）

对每份证据包执行现有语义工具链：`buildSemanticEvidenceBrief` → 模型推断 form / health_function / main_ingredients（图片用 localPath 直接读本地文件）→ `normalize` → `merge` → `semanticCompletion`。

- 出口三值：`enriched` / `review`（证据在但推断不了，带原因）/ `needs_browser`（证据本身缺）。
- 终止 = 队列排空；checkpoint 支持断点续。
- 不碰浏览器 → 免疫 binding 中断。

**回炉队列**（needs_browser）：Zoom 打不开、下载 403、展开失效等脚本取证失手的少数记录，由模型+浏览器定向补证据后送回语义队列。收敛的小尾巴，不是常态。

## 6. 三层验证

| 层 | 执行者 | 范围 | 验什么 |
|---|---|---|---|
| Tier 1 机械审计 | 代码 `verifyRunArtifacts(outDir)` | 全量，免费 | 账目自洽：discovered == complete+failed+excluded+remaining；state 声称的阶段 ⇔ 磁盘产物存在；每图 URL ⇔ 落盘文件；每 Facts 图 ⇔ 复核记录；每 not_present ⇔ 覆盖完整（§7）；每 review/failed ⇔ 有原因 |
| Tier 2 抽样实地 | 模型 + 浏览器 | 抽样 `min(10, 20%)` | ① 查漏（站→数据）：验证者独立走导航（不看生产者 seeds），随机开 K 个商品，逐一确认在记录里；② 查真（数据→站）：抽 K 条重开 productUrl 核对标题/价格/画廊数/变体数。抽样一败即升级：扩样或该维度全查 |
| Tier 3 语义对抗 | 模型，独立上下文 | main_ingredients 全量，form/health_function 抽样 | 输入只有证据包+结论（不含生产者推理），任务是设法推翻；逐条 confirmed / refuted，refuted 打回语义队列 |

- worker 无权自我宣告 complete；**complete = 通过 Tier 1 审计**，协调者收货前必跑。
- 验证① 查漏放在 harvest 之后、语义之前：漏商品早发现，别等清洗完才重爬。

**验证痕迹（通则，所有结论适用）**：

```jsonc
{
  "verdict": "confirmed",              // 或 refuted / not_present / pass / fail
  "method": "visual_image_read",       // 怎么验的：visual_image_read / dom_recheck /
                                       //   live_site_reopen / artifact_audit / count_reconcile
  "surface": "local_file",             // 在哪验的：local_file / dom_snapshot / live_site / artifacts
  "evidence": ["evidence/img/abc123.jpg#row:Vitamin C 500mg"],
  "verifier": "tier3:ingredients",     // 谁验的
  "round": 1
}
```

## 7. "没找到"的处理：缺失要有证明

"没找到"不是失败，是待证明的主张，不消耗重试预算：

```
找字段 X ──找到──► 正常终态（带痕迹）
    │没找到
    ├─ 覆盖有洞 ──► 定向补那个洞（不算重试）──► 回到"找"
    └─ 覆盖完整 ──► not_present 候选
                     ├─ 先验说正常 ──► 采信，终态 ✓
                     └─ 先验说反常 ──► 一次定向复核（本地文件，便宜）
                                        ├─ 确认无 ──► not_present 终态 ✓
                                        └─ 找到了 ──► 误判修正 ✓
```

- `not_present` 必附覆盖清单（看了哪几张图、展开了哪些面板、搜了哪些关键词、查了 JSON-LD 没有）；Tier 1 对着证据包机器对账，不靠自我报告。
- **先验（惊讶度）**：harvest 顺手统计站点/品类的字段出现率。本站 90% 商品有 Facts 图而某条声称没有 → 反常，值得一次定向复核；出现率本来 10% → 符合预期，直接采信。复核注意力只花在反常处。
- 重试预算只留给执行失败（403 / 超时 / 打不开），"再试一次可能就好"的才叫重试。

## 8. 防无限循环：四道闸

| 闸 | 规则 | 效果 |
|---|---|---|
| 1 尝试签名 | 每次重试记录 `(失败原因, 方法)`；同一组合禁止出现两次，想再试必须换方法；方法穷尽 → `review` | 杀死原地重打 |
| 2 三级预算 | 单记录：每种失败原因最多 2 次尝试 → review；模板族：同族 ≥50% 同一失败 → 熔断，修一次 profile，不行全族 review；整轮：verify→fix 最多 2 轮 → 剩余全部 review | 上界收敛 |
| 3 干轮检测 | 每轮净修复数 = 0 → 立即停（预算有剩也停）；记录状态出现回环（修 B 坏 A）→ 当场 review | 增量归零即收敛 |
| 4 review 终态 | 每条记录必居其一：`ok` / `excluded`(原因) / `review`(完整尝试史+原因)；运行级 complete = 全部到终态 + review 有原因 + 过 Tier1，**不要求 review 为空** | 给"体面放弃"出口，goal 才可达成 |

只有两种情况惊动用户：review 占比 > 20%（站点级问题，自动化无意义）；blocked 类原因（登录 / 授权 / challenge，机器等不来）。所有阈值（2 次 / 2 轮 / 50% / 20%）在 HarvestPlan.budgets 可调。

## 9. 线程模型：goal 契约 + 状态机 + 可重入

**一个线程 = 一个站点 = 一个 goal，全生命周期不换手。** 脚本运行期线程阻塞在 `await runHarvest()`，无交接。

**Goal prompt 模板**（派生 worker 任务时的初始 prompt 即 goal）：

```
你的唯一目标：让 <site> 达到三种终态之一，在此之前不得结束回合：
  complete / terminal(带证据) / blocked(点名具体阻塞物)
工作方式：读 <outDir>/state.json 决定从哪继续（状态机见下）。
汇报 incomplete 不是终点；incomplete 的唯一合法动作是 resume。
```

**state.json 状态机**：

```
missing        → 做 preflight A/B/C，写 HarvestPlan
plan_ready     → await runHarvest(plan)
harvest_done   → 验证①查漏 → 语义队列
incomplete     → 重建 binding，resume(plan, checkpoint)
semantic_done  → Tier1+2+3 验证 → verifying
verifying      → 按四道闸打回或通过
verified       → 严格导出，写 state=complete
complete       → 结束
```

**并发提前到 spawn 时刻**：协调者先验证独立浏览器 lease 数（`extensionInstanceId` / `browserId`），N 个 lease 开 N 个线程；共享 lease 的站点合进同一线程顺序跑。运行期零协调——协调者只轮询各线程 state.json，发现卡死/线程亡 → 把同一 goal prompt 原样重发（踢一脚），重入线程从磁盘续。原"preflight 调度屏障 + 协调者派发指令"协议废除。

## 10. 与现有代码的映射

| 新概念 | 复用现有 | 需新建 |
|---|---|---|
| Preflight A | `classifySiteOutcome` / `resolveEntryCrawlPlan` | — |
| Preflight B | visualRoute + profiles + 重放质量门 | — |
| Preflight C | `catalogCoverage` 的分页标记 | termination-contract schema |
| HarvestPlan | 各 profile 结构 | `lib/harvest-plan.mjs`（schema + 校验器） |
| runHarvest | `collectProductUrls` / `extractProductsBatch` / `upgradeProducts` / checkpoint | 生命周期状态机、不动点、看门狗、图片落盘、flags、oracle 对账 |
| EvidencePackage | `extractSupplementFactsFromHtml` / `classifyFactsImageCandidate` / `isHeadingOnlyDetailValue` | coverage 结构、落盘布局 |
| 语义队列 | `buildSemanticEvidenceBrief` / `normalize` / `merge` / `semanticCompletion` | 队列驱动 + localPath 读图约定 |
| Tier 1 | 严格导出门 / `assessProductRecordCompletion` | `verifyRunArtifacts()` + verification-report schema |
| Tier 2/3 | — | 验证协议（SKILL.md）+ 抽样助手 + 验证者 prompt 模板 |
| 防循环 | `disableAfter`（雏形） | 尝试签名 / 三级预算 / 干轮检测 |
| 线程模型 | `crawlWorkerTasks`（部分思想） | state.json 状态机 + goal 模板（文档） |

## 11. 实施顺序

1. `lib/harvest-plan.mjs`：HarvestPlan + EvidencePackage 双契约 schema + 校验器
2. `verifyRunArtifacts()` 审计器 + `verification-report.json` schema（纯代码，先行见效）
3. `runHarvest()` 引擎（包装现有函数进生命周期）
4. 语义队列驱动 + not_present 覆盖/先验规则
5. SKILL.md 重写：三步 preflight、goal 模板、状态机、验证协议、四道闸；废除调度屏障协议
6. 多站点 spawn 协议更新（multithread-browser-workers.md 大幅简化）
