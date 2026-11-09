# AI 能力 S 级标准（v0.10.0 验收口径）

> 这份文件是 `v0.10.0「模型层全面升级」` 的验收基准，不是宣传页。
> 每一条都写了**实现位置**与**验证方式**；做不到的条目会明说「未做」，不会用形容词盖过去。
>
> 三层是递进的：**L1 接入**（请求发得出去、错误说得清）→ **L2 分析**（答得对、结论可信）→
> **L3 交互**（看得懂、错得能救、花的钱看得见）。任一层不达标，整体就不算达标。

## 一句话判定

> 关掉网络，产品依然完整可用；打开 AI，每份结论都能追到原文，
> 每次失败都能自己救回来，每一分 token 都看得见。

---

## L1 · 接入层（10 条）

| # | 标准 | 实现位置 | 验证方式 |
|---|---|---|---|
| L1-1 | 八家厂商预设（Ollama / LM Studio / vLLM / DeepSeek / 百炼 / 硅基流动 / OpenAI / 自定义） | `components/ai/AiSettingsPanel.tsx` `PRESETS` | `AiSettingsPanel.test.tsx`：八条预设全渲染、点 DeepSeek 写入云端地址且 `isLocal=false` |
| L1-2 | 连通性自检：`/models` 探活 + 最小 chat 探针，**只在用户点击时发** | `ai/gateway.ts` `probeConnection` | `gateway.test.ts` 5 条探针用例；`check:no-network` 单点审计仍绿 |
| L1-3 | 模型名可下拉（上次探活结果），也可手填 | `AiSettingsPanel` `<datalist>` | `AiSettingsPanel.test.tsx`：`lastCheck.models` 进 option |
| L1-4 | `temperature` / `top_p` / `max_tokens` 可配，**缺省不发** | `gateway.buildRequestBody` / `resolveParams` | `gateway.test.ts`：未配置时 body 不含这三个键；配了才出现 |
| L1-5 | 推理模型兼容 `reasoning_content`（流式 + 非流式） | `gateway.parseSseStream` / `parseJsonResponse` | `gateway.test.ts`：思考不混进正文；只有思考时给明确错误 |
| L1-6 | 流式用量，`stream_options` 不支持时本次自动降级 | `gateway.chatCompletions` 降级循环 | `gateway.test.ts`：400 后摘字段重试成功，calls=2 |
| L1-7 | 错误细分 8 类，每类一句中文动作建议 | `gateway.ERROR_HINT` / `classifyStatus` | `gateway.test.ts`：auth / not_found / rate_limit 各一条 |
| L1-8 | 429 按 `Retry-After` 退避（≤10s），普通重试带确定性抖动 | `gateway.parseRetryAfter` / `backoffOf` | `gateway.test.ts`：429 + `Retry-After: 3` 退避后成功 |
| L1-9 | token 预算估算（按 token 而非字符），发送前可见 | `ai/budget.ts`；面板 `ai-tokens` | `budget.test.ts` 7 条；`AiScenarioPanel.test.tsx` 断言「约 N tokens」 |
| L1-10 | 同场景重复提交防护（连点不发两次） | `AiScenarioPanel` `inFlight` ref | `AiScenarioPanel.test.tsx`：生成中不出现生成按钮，只出现停止 |

## L2 · 分析层（8 条）

| # | 标准 | 实现位置 | 验证方式 |
|---|---|---|---|
| L2-1 | **D20 带简历模块**（否则只是分析 JD） | `prompts.ts` d20 fields + `modulePickOf('d20-analysis')` | `scenarios.test.ts`：字段表含 `selectedModules` 且默认不勾；勾了消息里才出现 |
| L2-2 | 八场景 prompt 含角色/契约/边界/正例/反例 | `ai/prompts.ts` | `scenarios.test.ts`：每个场景都含「正例」「反例」「JSON」 |
| L2-3 | 解析失败自动纠错重试一次 | `prompts.buildRepairMessages` + `App.runAiScenario` | `scenarios.test.ts`：消息顺序与 6000 字截断 |
| L2-4 | 证据可追溯（不命中则摘证据、留建议） | `ai/evidence.ts` `auditEvidence` | `evidence.test.ts` 11 条：编造被抓、截短放过、不误杀标点差异 |
| L2-5 | 场景级温度：解析 0，生成 0.3 | `prompts.scenarioParams` | `scenarios.test.ts`：五个解析类 0 度、两个生成类 0.3 |
| L2-6 | 长面经分块（仅 d14-bulk），失败块原文不丢 | `ai/chunk.ts` + `App.runBulkChunked` | `chunk.test.ts` 6 条：不超预算、内容不丢、单行也能切 |
| L2-7 | 维度形态自检（全 strong / 全 gap / 全 not_found） | `reports.verdictPatternOf` / `verdictWarningOf` | `reports.test.ts` 5 条 + `ReportCard.test.tsx` 3 条 |
| L2-8 | 降级链：严格 JSON → 宽松解析 → 明确部分成功 | D14/D15 已有宽松解析；D17/d19 不猜（见「已知边界」） | `scenarios.test.ts` 解析用例 |

## L3 · 交互层（8 条）

| # | 标准 | 实现位置 | 验证方式 |
|---|---|---|---|
| L3-1 | 配置向导：预设 → 测试 → 选模型 → 参数 | `AiSettingsPanel` | `AiSettingsPanel.test.tsx` 12 条 |
| L3-2 | 生成阶段化（连接 / 已生成 N 字）+ 可取消 | `AiScenarioPanel` `stage` / `chars` | `AiScenarioPanel.test.tsx`：生成中显示「已生成」 |
| L3-3 | 失败三动作：重试 / 非流式 / 去配置 | `AiScenarioPanel` `retry(stream)` | 同上：重试复用同一份勾选、点「去检查配置」触发回调 |
| L3-4 | 每次调用显示 tokens / 耗时 / 模型 | `RunMeta` + `fmtMeta` | 同上：`ai-meta` 含 1000 tokens / 3.2s / 模型名 |
| L3-5 | 用量面板（次数 / tokens / 最近失败） | `AiSettingsPanel` `summarize` | `AiSettingsPanel.test.tsx`：1.2k tokens + rate_limit |
| L3-6 | 建议 diff + 全部忽略 | `SuggestionList` `originalOf` / `suggestion-reject-all` | `SuggestionList.test.tsx` 4 条 |
| L3-7 | 报告卡维度表 + 导出 Markdown | `ReportCard` + `reports.reportToMarkdown` | `ReportCard.test.tsx`：data URI 下载；`reports.test.ts`：竖线转义 |
| L3-8 | `aria-live` 播报生成 / 失败 / 用量 | `AiScenarioPanel` 三处 | 代码审阅（无自动化断言，如实标注） |

---

## 如实标注的三处边界

1. **L3-8 只有代码实现，没有自动化断言**。`aria-live` 是给屏幕阅读器用的，
   jsdom 里断言属性存在容易变成「测了个字符串」。这条靠人工审阅，不假装有测试。
2. **L2-6 只给 d14-bulk 分块**。简历诊断/竞争力分析需要整体视角，切块会把「对照」降级成
   「片段比较」，明知有害所以不做 —— 这不是漏做，是拒绝。
3. **D17 / d19-jd 没有宽松兜底**。它们的输出会写进真实字段，猜错的代价远大于少一条建议；
   证据对不上时只摘证据、不动内容。

## 一条命令验收

```bash
cd app
npm run verify        # typecheck + lint + test + classes + no-network + build + bundle + versions
npm run check:print   # 真浏览器打印断言
npm run check:resume  # 真浏览器简历渲染断言
```
