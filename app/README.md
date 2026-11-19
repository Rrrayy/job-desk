# app/ —— 应用本体

「求职工作台」的前端工程：**Vite 5.4 + React 18.3 + TypeScript 5.6**，无 UI 组件库，
样式是唯一一份手写 `src/styles.css`，构建产物是单个 `dist/index.html`（JS/CSS 全内联）。

> 用户文档（怎么用、数据存哪、同步怎么做、快捷键）在根目录 [`../README.md`](../README.md)。
> 这份只讲**怎么改代码**。

---

## 1. 常用命令

```bash
npm install
npm run dev        # http://localhost:5173
npm run verify     # 九道关卡全绿才算能提 PR
```

`npm run verify`（`package.json` 里的顺序就是执行顺序）：

```bash
npx tsc --noEmit                    # 1 类型（strict + noUncheckedIndexedAccess）
&& npm test                         # 2 1506 条 / 91 文件
&& npm run lint                     # 3 correctness + hooks + 架构边界
&& npm run check:no-network         # 4 11 条规则，白名单为空
&& npm run build                    # 5 产出 dist/index.html
&& npm run check:bundle             # 6 总量 960 KB 警告 / 1.00 MB 失败；分项 CSS 100 / JS 780 / 中文 85 KB 硬红线
&& npm run check:classes            # 7 类名压缩表往返一致 + 黄金副本等价
&& npm run check:versions           # 8 package.json = 扩展 manifest = 产物
&& npm run validate:community       # 9 ../community 面经格式 + 脱敏
```

两条**要起真 Chromium** 的关卡不进 `verify`（慢），动过简历模板或打印样式必须单独跑：

```bash
npm run check:print     # 8 套模板分页与装饰，95 条断言
npm run check:resume    # 简历绑定 / 版本 / 导出链路
```

其余脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 只跑 `tsc --noEmit` |
| `npm test` | 串行跑 vitest（`PARALLEL=1 npm test` 可并行） |
| `npm run test:watch` | 监听模式（只用于本地调一个文件） |
| `npm run preview` | 预览 `dist/`（构建后才有意义） |
| `npm run lint:fix` | 自动修可修的 lint |
| `npm run check:bundle` | 单独看体积 |
| `npm run check:no-network` | 单独扫网络调用 |
| `npm run release:pack` | 打发布包（`index.html` + 扩展 zip + manifest + SHA256SUMS） |
| `npm run release:prep` | `verify` + 两条浏览器关卡 + 打包，发版前一把梭 |

产物：`dist/index.html` 约 **838,781 B（819.1 KB）**，`file://` 双击即用。

---

## 2. 代码地图

```
src/
├── main.tsx              挂载
├── App.tsx               状态中枢：所有写操作走 mutate()，含撤销快照与 UI 视图状态
├── types.ts              数据模型（schemaVersion 6 / sync / 简历 / 面经 / 插件）
├── styles.css            全部样式（CSS 变量做令牌；禁止内联 style）
├── lib/
│   ├── api.ts            AppApi 类型契约（组件只依赖类型，避免循环依赖）
│   ├── rules.ts          沉默派生 / 待办聚合 / 漏斗 / 冲突检测 / 话术 / 状态 recipe
│   ├── date.ts           本地自然日工具（不用 UTC，避免天数错位）
│   ├── storage.ts        localStorage 读写 + 导入导出 + schema 校验
│   ├── storage/          存储后端：http(s) → IndexedDB，file:// → localStorage，启动探测
│   ├── migrate.ts        migrateV2ToV3 是分发入口（名字沿用历史）：任意老版本 → 当前
│   ├── rollback.ts       迁移前回滚点（jobdesk.v1.preMigrate.<ISO>，留 30 天）
│   ├── validateV1.ts     老库校验（迁移前）
│   ├── validateV2.ts     新库校验（迁移后 / 导入时）
│   ├── defaults.ts       默认设置 / 空库 / 示例库
│   ├── budget.ts         库体积水位（3.5 MB 警告 / 4.5 MB 拒绝写入）+ 字段截断
│   ├── classTokens.ts    类名压缩表（**自动生成，不许手改**，见 §4）
│   ├── interview.ts      面经：题型、根因、间隔复习（+1/+3/+7 天）
│   ├── merge.ts / csvImport.ts / tableExport.ts / portable.ts   导入导出
│   ├── trash.ts          回收站（30 天）
│   ├── fileLink/         文件联动：handle / hash / pending / engine
│   ├── capture/          一句话快记：dict.ts（词表）+ parse.ts（纯解析）
│   ├── offer/            Offer 决策台：score / compare / decision / validate
│   ├── company/          公司档案：dossier（聚合）+ fields（11 个字段）
│   ├── silence/          沉默待办：list.ts（分组与排序）
│   └── sync/
│       ├── normalize.ts  归一化 + Dice 相似度 + matchKey（有 NORMALIZE_VERSION）
│       ├── statusMap.ts  平台文案 → 9 个内部状态（产品语义在这里）
│       ├── ownership.ts  字段归属表（Record<keyof Application, Ownership>，编译期穷尽）
│       ├── engine.ts     plan() 五级去重与差异 / apply() 写入 / revertSync() 撤销
│       ├── capture.ts    三通道统一：JSON 信封 job-desk/capture@1 / 纯文本 / 文件
│       └── types.ts      MergePlan / PlannedRow / StagedSyncItem / SyncUndo
├── ai/                   AI 层（唯一允许 fetch 的地方）
│   ├── gateway.ts        **网络唯一出口**，含连通性探针
│   ├── scenarios.ts      八场景 prompt / prompts.ts 模板 / suggestions.ts 建议 diff
│   ├── chunk.ts          长文本分块 / evidence.ts 证据核对 / budget.ts token 预算
│   └── context.ts / requestLog.ts / settings.ts / reports.ts / experienceBulk.ts
├── resume/               简历：schema / draft / versions / bind / print / photo / templates
├── plugins/              插件机制：manifest / sandbox / broker / storage
├── adapters/             纯解析：一个平台一个目录（boss | liepin | shixiseng | nowcoder | custom）
└── components/
    ├── TopBar TodoBar Toast Welcome ErrorBoundary Field BulkBanner
    ├── TodayView BoardView ListView CalendarView InsightsView
    ├── DetailDrawer QuickAdd CsvImportDialog ImportConfirm JdPanel
    ├── FileLinkPanel BindVersionSelect SettingsDrawer MigrationFailPage
    ├── ai/          AiScenarioPanel AiSettingsPanel SendPreviewDialog SuggestionList
    ├── capture/     QuickCapture CaptureChips
    ├── company/     CompanyDossier CompanyFields
    ├── list/        SilenceList BatchBar
    ├── offer/       OfferSection OfferPanel CompareTable WeightPanel DecisionForm
    ├── resume/      ResumeView ResumeEditor ResumeList VersionMenu …（15 个）
    ├── plugins/     PluginsPanel
    ├── settings/    ResumeTrashSection
    ├── sync/        RiskGate StagingList Step1Capture Step2Preview Step3Confirm SyncDrawer badges
    └── interview/   面经九件：QuickNote ExperienceEditor QuestionBank ReviewCards …
                      InterviewStats MasteryCategoryPicks InsightsTabs CommunityImport BulkPastePanel
```

### 三条结构硬规矩

1. **组件不直接改 state，全部走 `api.*`。** `AppApi` 是类型契约，组件只 `import type`，
   不给组件开 `setState` 的口子 —— 否则撤销快照会漏。
2. **`adapters/` 只吃字符串。** eslint 对它硬禁 `react` / `react-dom` / `lib/storage` /
   `lib/sync`，并禁 `document` / `window` / `fetch`（架构 D-02）。
   `lib/` 不硬禁 React —— 像 `virtual.ts` 只 `import type`，硬禁会误伤；靠 `consistent-type-imports` 与评审守。
3. **网络只许出现在 `ai/gateway.ts`。** `check:no-network` 扫 11 条规则，白名单为空；
   任何新出口都会红。

---

## 3. 数据与迁移

| 键 | 内容 |
| --- | --- |
| `localStorage['jobdesk.v1']` | 全量数据（**`schemaVersion: 6`**）：`settings / companies / applications / interviews / notes / experiences / questions / staging / events / pluginStorage / requestLog / aiSuggestions / resumes / resumeVersions / aiReports`，外加可选的顶层 `offerDecision` |
| `localStorage['jobdesk.v1.ui']` | 上次视图（刷新还原） |
| `localStorage['jobdesk.v1.listFilters']` | 列表筛选状态 |
| `localStorage['jobdesk.v1.preMigrate.<ISO>']` | 迁移前回滚点，保留 30 天 |
| `localStorage['jobdesk.v1.failedAt.<ISO>']` | 读取失败时的原文备份（锁定写入，不覆盖） |

**键名 `jobdesk.v1` 永远不改**（改了等于老用户数据消失）。schema 版本走数据内部的 `schemaVersion`。
导出侧另有 `FORMAT_VERSION_CURRENT = 5`，与 `schemaVersion` **解耦**：它只是文件标记，导入时按
`schemaVersion` 判兼容。

迁移约束（改 `migrate.ts` 前必读）：

- 纯函数：时间从 `ctx.nowIso` 注入，**不读 `Date.now()`**。
- 只加不减：旧字段一个不删。
- 幂等：`migrate(migrate(x)) === migrate(x)`，已是当前版本时 `changed === false`、原对象一字不改。
- v1 备份导入**走同一个函数**，不存在第二条没测过的升级路径。
- 审计写 `settings.lastMigration`（在 `settings` 下，**不在 `DB` 根上**）；链式迁移只记一条「起点 → 终点」。
- **版本高于当前 = 硬拒绝**（`migrate.ts:81`），不是「尽力兼容」。加版本必须同步改这里与 `validateV2.ts`。

---

## 4. 样式与类名

- 全部在 `src/styles.css`，**禁止 `style={{}}` 内联**（少数动态宽度用 CSS 变量传值）。
- 颜色 / 圆角 / 阴影只从 CSS 变量取（文件顶部 `:root`）。
- 类名用 BEM 风格：`sync__card--conflict`。新增模块先想前缀（`sync__` / `exp__` / `qb__` / `offer__` / `cap__`），
  不要造新的一级命名空间。
- 主断点两个：`900px` 与 `520px`（各 3 处）；另有几处单点宽度（720 / 760 / 1000 / 1100 / 1180）服务于表格与日历。

### 类名压缩表（必读，否则会踩坑）

构建前 `scripts/tokenize-classes.mjs --write` 会把源码里的字面类名换成 `CLS.xx` 短 token，
`src/lib/classTokens.ts` 是**生成物**（上限 100 条），`classTokens.golden.json` 是黄金副本（不进产物）。

```bash
node scripts/tokenize-classes.mjs --write   # 改完样式后重新生成；不要手改 classTokens.ts
node scripts/tokenize-classes.mjs --check   # 进 verify：六条断言
```

- **加新类名**：只在 `styles.css` 与组件里写字面串，然后 `--write`，不要自己编 token。
- **删 / 改类名**：`--write` 会把掉出表的串**还原成字面量**并删掉多余的 `import { CLS }`。
- **不要手工重排 token**：`stablePlan()` 保证仍在表内的值沿用原 token；重新编号会让旧 class 变成别的样式
  （v1.0.0 踩过一次：7 个 token 被重排，29 处 UI 静默变样，所有测试和门禁全绿也没发现）。

---

## 5. 加东西之前

- **加一个平台** → 看 [`../docs/adapters/README.md`](../docs/adapters/README.md)（七步 + 脱敏要求）。
- **加一条产品语义映射** → 改 `lib/sync/statusMap.ts` 的 `STATUS_RULES`，**不要**改适配器。
- **给 `Application` 加字段** → 必须同时在 `lib/sync/ownership.ts` 的 `FIELD_OWNERSHIP` 声明归属，
  否则 `tsc` 会报错（这是故意的）。同步字段还要加进 `SYNC_WRITABLE`。
- **改状态流转** → 只改 `lib/rules.ts` 的 `applyStatusChange`，UI 侧不要再写一份 recipe
  （两份 recipe = 撤销回滚漏字段，v1.0.0 修过一次）。
- **七条语义红线** → [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 第 2 节。改同步相关代码前请逐条对照。
