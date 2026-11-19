# 贡献指南

先谢过。这个项目的**边界比功能重要**，所以下面前两节请务必读完 —— 很多「合理的功能建议」在这里会被拒绝，不是因为不想要，而是因为越界了。

---

## 0. 三十秒版本

```bash
git clone <repo>
cd job-desk/app
npm install
npm run verify      # 九道关卡，全绿才算能提 PR
npm run dev         # 开发模式，http://localhost:5173
```

- 提 PR 前必须 `npm run verify` 全绿（CI 会再跑一遍，Node 22 / 24 双矩阵）。
  本机需要 **Node ≥ 22.22.2** —— 不是洁癖，是 `jsdom@30` 与 `eslint@10` 的 `engines` 下界，
  低于它 `npm test` 会在 jsdom 构造阶段就崩，报错看起来像「测试挂了」而其实是环境不达标。
  改依赖后跑一次 `node scripts/check-engines.mjs` 可以确认下界有没有被抬高。
- 有 bug 或想法？先开 Issue，用仓库里的模板（bug 模板第一句会教你先把数据抢救出来）。
- **不要**在 PR 里顺手格式化整个文件、升级无关依赖、改别人写的文案。

---

## 1. 这个项目明确不做什么

以下四条是产品边界，PR 提了也不会合（Issue 里讨论可以）：

| 不做 | 原因 |
| --- | --- |
| 自动登录 / 抓取招聘平台 | 要存 cookie 或账号、要过验证码，既不合规也把我们变成「数据中介」。同步永远是你给文本、我们解析。 |
| 除 AI 调用以外的任何网络请求 | 数据只在你浏览器里。唯一出口是 `app/src/ai/gateway.ts`（你填自己的 API Key，直连你选的厂商）；其余 `fetch` / `XHR` / `sendBeacon` / `WebSocket` / 远程 script 全部由 `check:no-network` 在 CI 里拦住，白名单文件**保持为空**。 |
| 云同步 / 账号体系 | 一旦有服务器，「数据只留在你本机」这句话就不成立了。备份靠导入导出。 |
| 简历代写 / 自动投递 | 简历模块做「结构化录入 + 8 套模板打印 + 版本绑定」，不做内容代写；AI 只出**建议**（带 diff，你点了才写库），不代写、不自动改、不替你投。 |

另外：**不要引入 UI 组件库**。样式是手写的一份 `app/src/styles.css`，用 CSS 变量做设计令牌。
这不是技术保守，是为了让产物能压进一个 `index.html`（体积红线见第 4 节）。

---

## 2. 七条语义红线（改代码前必须知道）

这七条是数据正确性的地基。**改之前先开 Issue 说明为什么非改不可**，改完必须在 PR 描述里逐条打勾。

1. **同步写入的 note，`touchedAt` 只能用平台给的 `lastContactAt`。**
   绝不能用「抓取时刻」。否则用户一同步，20 条沉寂的记录全部「今天有活动」，沉默判定直接失效。
2. **`lastActivityAt` 必须走 `max()` 重算**（复用 `lib/rules.ts` 的 `lastActivityAtOf`），
   **禁止调用 `App.addNote`** 来「顺便刷新活动时间」。同步是重放事实，不是产生活动。
3. **没有变化的记录不写 note。** 一次同步跑两次，第二次必须全部落进「无变化」，库里的 note 数量一条不增。
4. **平台「邀请面试」只映射到 `chatting` + 一条待办。**
   不许自动进 `scheduled`，不许自动造 Interview 记录 —— 约在第几轮、约的几点，只有用户知道。
5. **迁移（`app/src/lib/migrate.ts`）必须是无损、幂等、可回滚的纯函数。**
   只加字段不减字段；时间从 `ctx.nowIso` 注入，不读 `Date.now()`；迁两次结果和迁一次相同。
   分发入口是 `migrateV2ToV3`（名字沿用历史，实际语义是「任意老版本 → 当前版本」）。
6. **localStorage 键名 `jobdesk.v1` 不许改。** 改了等于所有老用户数据「消失」。
   schema 版本走数据内部的 `schemaVersion`，不走键名。
7. **产物必须是单个 `app/dist/index.html`。** 不许拆出 `assets/*.js`、不许走 CDN、不许要求起服务。

---

## 3. 目录导览

```
job-desk/
├── app/                    # 应用本体（Vite + React + TS）
│   ├── src/
│   │   ├── App.tsx         # 状态中枢：所有写操作走 mutate()，含撤销快照
│   │   ├── types.ts        # 数据模型
│   │   ├── styles.css      # 全部样式（唯一一份）
│   │   ├── adapters/       # 适配器：纯解析函数，一个平台一个目录
│   │   ├── ai/            # AI 层：gateway.ts 是唯一网络出口，其余纯函数
│   │   ├── resume/         # 简历：schema / 版本 / 绑定 / 打印 / 8 套模板
│   │   ├── plugins/        # 插件机制：manifest / sandbox / broker / storage
│   │   ├── lib/            # 纯逻辑：rules / storage / migrate / interview / budget ...
│   │   │   └── sync/       # 同步引擎：normalize / statusMap / ownership / engine
│   │   └── components/     # 视图与浮层
│   └── scripts/            # 自检脚本（bundle / no-network / classes / versions / community）
│                           # + 冒烟（print / resume / plugin）+ 发版（pack / publish）
├── extension/              # 可选：MV3 扩展，抓当前页 → 剪贴板
├── community/              # 可选：社区面经（CC BY-SA 4.0）
├── docs/                   # 架构 / PRD / 适配器文档
└── .github/                # CI + Issue / PR 模板
```

一条硬规则：**`adapters/` 里不许 import React，不许 import `storage` / `lib/sync`，不许读 DOM、不许 `fetch`**
（eslint `no-restricted-imports` + `no-restricted-globals` 硬拦）。`lib/` 不硬禁 —— 像 `virtual.ts` 只
`import type`，硬禁会误伤，靠 `consistent-type-imports` 与评审守。
纯逻辑必须能在 node 环境里直接单测；碰 DOM 和 localStorage 的只能是 `components/` 与 `App.tsx`。

### 3.1 纯函数必须自带同名测试（或登记豁免）

**凡在 `app/src/lib/**` 下新增纯函数模块，必须在同一批改动里新增同名 `.test.ts`**
（`lib/foo.ts` → `lib/foo.test.ts`）。做不到就在本节末尾登记豁免，写清楚为什么做不到
（「还没写」不算理由；「依赖 `window`，只能在组件层测」算）。

为什么是**人工规则**而不是覆盖率工具：本仓 `npm test` 已经是「91 文件 / 1506 条」的确定性闸门，
再引一个 `c8` / `istanbul` 只换来一个新 devDependency、一份新配置和一堆「覆盖率 63%」的噪声，
而我们要守的是**「纯函数有测试」这条底线**，不是某个百分比 —— 指标一旦可度量，就会有人为了
数字写空测试。这条规则只需要人能回答一句「这个模块的测试文件在哪」。

**当前账（2026-11-19 实测，只列不改）**：

| 状态 | 数量 | 模块 |
| --- | --- | --- |
| 有同名 `.test.ts` | 16 | `boardWindow` · `courseImport` · `crypto` · `csvImport` · `interview` · `interviewMarkdown` · `merge` · `migrate` · `portable` · `rules` · `selfSnapshot` · `startup` · `storage` · `tableExport` · `trash` · `virtual` |
| 无同名测试，但被其他测试间接 import | 6 | `api`（19 个测试文件）· `defaults`（32）· `sample`（4）· `date`（1）· `util`（1）· `validateV2`（1） |
| 无同名测试，也没有任何测试 import | 4 | `budget` · `classTokens` · `rollback` · `validateV1` |

最后一行那 4 个是这条规则生效**之前**的存量欠账（本版不清理，只登记）。**新增模块不许再欠。**
另外 `lib/disaster.test.ts` 是跨模块的灾难恢复用例，没有同名 `disaster.ts` —— 这不算违规，
它是「一个测试覆盖多个模块」的合法形态。

---

## 4. 九道关卡（`npm run verify`）

在 `app/` 下执行，等价于 CI 的九步：

| 命令 | 管什么 | 失败了怎么办 |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | 别用 `any` 糊过去。真需要 `any` 就在 PR 里说明理由。 |
| `npm test` | **1506 条 / 91 个文件**（含组件 jsdom 用例） | 测试挂了**改代码，不改断言**；确属断言过期，逐个在 PR 里说明理由。 |
| `npm run lint` | correctness + hooks + 架构边界（`adapters/` 禁 import React 与 storage、禁读 DOM、禁 fetch） | 修代码，不加 `eslint-disable`。 |
| `npm run check:no-network` | 扫 `app/src` + `extension`，禁止一切网络调用 | 真有正当理由 → 加到 `.github/no-network-allowlist`，并在 PR 里解释。**默认应当是空文件。** |
| `npm run build` | 产出单文件 `dist/index.html` | 构建挂了先看 `vite.config.ts` 的 `base: './'` 和 `viteSingleFile()` 有没有被改。 |
| `npm run check:bundle` | 总量 > 960 KB 警告、> 1 MB 失败；**分项 CSS ≤ 100 KB / JS ≤ 780 KB / 中文 ≤ 85 KB 直接失败**；单次较基线涨 > 20 KB 也告警 | 先看报的是哪一项：CSS 胖 → 合并同 `@media` 下声明体相同的规则组、删死 CSS；JS 胖 → 砍功能或换更小的依赖（**按需拆包在本仓无效**，`viteSingleFile` 会把动态 `import()` 也内联回同一个 html）；中文胖 → 压文案（3 B/字，minifier 一个字都压不掉）。 |
| `npm run check:classes` | 类名压缩表往返一致、无漏网、黄金副本等价（100 条上限） | 改了 UI 就跑 `node scripts/tokenize-classes.mjs --write` 再 `--golden`。**顺序不能反，也不要手改表。** |
| `npm run check:versions` | `package.json` / 扩展 `manifest.json` / 产物三处版本必须一致 | 三处一起改。 |
| `npm run validate:community` | 校验 `community/` 的 id、枚举、长度、脱敏、索引对账 | 见第 6 节。 |

另有两条要真浏览器的门禁，不进 `verify`（慢）：`npm run check:print`（8 套模板打印分页）与 `npm run check:resume`。改了简历模板或打印样式必须跑。

单跑某一个：

```bash
npm run typecheck
npm test
npm run build && npm run check:bundle
```

> `npm test` 默认**串行**执行（`--no-file-parallelism`）。原因是 Windows 上 vitest 的临时目录
> 偶发 `EPERM`，串行换来确定的退出码，这笔交易划算。
> 想并行：`PARALLEL=1 npm test`。

---

## 5. 新增一个招聘平台适配器

适配器是**社区契约**，改动它等于改协议。完整文档见 [`docs/adapters/README.md`](docs/adapters/README.md)，这里是速查：

1. 建目录 `app/src/adapters/<平台>/`，写 `adapter.ts` + `parse.ts` + `parse.test.ts` + `fixtures/*.txt`。
2. `parse.ts` 必须是**纯函数**：`(raw: AdapterInput, ctx: ParseContext) => AdapterResult`。
   不读 `Date.now()`（时间从 `ctx.now` 来）、不读 DOM、不发请求。
3. 拿不到公司名的行**必须**落进 `unparsed`，并给一句人话原因（「这一行没有公司名」）。
   **绝不编造**，也绝不静默丢。
4. `lastContactAt` 拿不到就 `undefined` —— **不许**用 `ctx.capturedAt` 顶替（违反红线 1）。
5. 状态文案**原样**填进 `platformStatusText`，不要自己解释成内部状态 ——
   那一步由 `lib/sync/statusMap.ts` 统一做。
6. `fixtures/` 里的文本必须**脱敏**：真实公司名可保留（公开投递事实），但人名、手机号、邮箱、
   微信号、内推码一律替换。
7. 在 `app/src/adapters/registry.ts` 加一行注册，在 `registry.test.ts` 补一条 URL 命中用例。
8. 在 PR 模板里勾「新增适配器」，并把 `lastVerifiedAt` 写成你**真的看过那个页面**的日期。

> 页面结构会变。`lastVerifiedAt` 超过 6 个月，UI 会标「⚠️ 可能已失效」——
> **标但不阻断**，因为「可能失效」不等于「一定失效」，用户手里还有预览那一步可以兜。

---

## 6. 贡献面经（`community/`）

面经内容按 **CC BY-SA 4.0** 授权，与代码的 MIT 是两套许可。格式见 [`community/SCHEMA.md`](community/SCHEMA.md)。

五条红线，任何一条不过都会被 `validate:community` 硬拦：

1. **脱敏**：不出现手机号、邮箱、身份证、QQ、微信号、HR / 面试官姓名。
2. **不抄答案**：`myAnswer` 写「你当时怎么答的、哪里卡住」，不是抄标准答案。
3. **不写公司内部信息**：薪资明细、未公开的业务数据、内部系统截图描述，一概不要。
4. **长度限制**：公司名 / 岗位名 ≤ 40 字，题目 ≤ 200 字，答案与总结 ≤ 2000 字。
5. **id 唯一**：`^[a-z0-9][a-z0-9-]{5,60}$`，形如 `bd-2025-03-q1`。

加一篇的流程：写 JSON → 更新 `_index.json`（`questionCount` 必须和实际题数相等）→
`cd app && npm run validate:community` → 提 PR。

**隐私优先级高于完整性。** 少写一句，也不要带进别人的私人信息。

---

## 7. 提交与 PR

- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `feat: 实习僧适配器`、`fix: 同步后沉默计时被重置`、`docs: 补适配器失效处理`、`test: 补去重第五级用例`。
- 一个 PR 做一件事。重构与功能改动**不要**混在一起 —— 不然 review 时无法判断哪一行是 bug。
- PR 描述按模板填，特别是「语义红线自查」和「有没有暂时先这样」两栏。
  「暂时先这样」是诚实的表达，我们欢迎；把它藏起来才是不欢迎的。
- 涉及 UI 改动请附截图（拖拽 / 抽屉 / 窄屏各一张最好）。
- 不要 `--no-verify` 跳过 hook，不要 `git push --force` 到别人的分支。

---

## 8. 环境

| 项 | 要求 |
| --- | --- |
| Node | ≥ 18（CI 跑 18 与 20） |
| 包管理 | npm（仓库里有 `package-lock.json`，别换成 yarn/pnpm 提交 lockfile） |
| 浏览器 | Chrome / Edge / Safari 最近两个大版本 |
| 编辑器 | 有 `.editorconfig`，缩进 2 空格、LF、UTF-8、去尾随空格 |

遇到问题先搜 Issue，再开新 Issue。卡住了就在 Issue 里写清楚卡在哪 —— **说清楚比做出来更重要**。
