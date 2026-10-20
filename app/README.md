# app/ —— 应用本体

这是「求职工作台」的前端工程：**Vite 5 + React 18 + TypeScript 5.6**，无 UI 组件库，
样式是唯一一份手写 `src/styles.css`，构建产物是单个 `dist/index.html`。

> 用户文档（怎么用、数据存哪、同步怎么做、快捷键）在根目录 [`../README.md`](../README.md)。
> 这份只讲**怎么改代码**。

---

## 1. 三条命令

```bash
npm install
npm run dev        # http://localhost:5173
npm run verify     # 六道关卡全绿才算能提 PR
```

`npm run verify` 展开是：

```bash
npx tsc --noEmit          # 类型
&& npm test               # 129 个纯函数用例
&& npm run check:no-network   # 禁止一切网络调用
&& npm run build          # 产出 dist/index.html
&& npm run check:bundle   # 450 KB 警告 / 600 KB 失败
&& npm run validate:community # 校验 ../community
```

其余脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 只跑 `tsc --noEmit` |
| `npm test` | 串行跑 vitest（`PARALLEL=1 npm test` 可并行） |
| `npm run test:watch` | 监听模式（只用于本地调一个文件） |
| `npm run preview` | 预览 `dist/`（构建后才有意义） |
| `npm run check:bundle` | 单独看体积 |
| `npm run check:no-network` | 单独扫网络调用 |
| `npm run validate:community` | 单独校验面经 |

产物：`dist/index.html` 约 **412 KB**（`file://` 双击即用）。

---

## 2. 代码地图

```
src/
├── main.tsx              挂载
├── App.tsx               状态中枢：所有写操作走 mutate()，含撤销快照与 UI 视图状态
├── types.ts              数据模型（含 schemaVersion、sync、面经类型）
├── styles.css            全部样式（CSS 变量做令牌；禁止内联 style）
├── lib/
│   ├── api.ts            AppApi 类型契约（组件只依赖类型，避免循环依赖）
│   ├── rules.ts          沉默派生 / 待办聚合 / 漏斗 / 冲突检测 / 话术
│   ├── date.ts           本地自然日工具（不用 UTC，避免天数错位）
│   ├── storage.ts        localStorage 读写 + 导入导出 + schema 校验
│   ├── migrate.ts        migrateV1ToV2：纯函数、幂等、只加不减
│   ├── rollback.ts       迁移前回滚点（jobdesk.v1.preMigrate.<ISO>，留 30 天）
│   ├── validateV1.ts     老库校验（迁移前）
│   ├── validateV2.ts     新库校验（迁移后 / 导入时）
│   ├── interview.ts      面经：题型、根因、间隔复习（+1/+3/+7 天）
│   ├── interviewMarkdown.ts  一场面试导出 .md
│   ├── budget.ts         体积水位（3.5 MB 警告 / 4.5 MB 拒绝写入）+ 字段截断
│   ├── defaults.ts       默认设置 / 空库 / 示例库
│   ├── sample.ts         示例数据
│   ├── util.ts           id / 深拷贝 / 剪贴板 / className
│   └── sync/
│       ├── normalize.ts  归一化 + Dice 相似度 + matchKey（有 NORMALIZE_VERSION）
│       ├── statusMap.ts  平台文案 → 9 个内部状态（产品语义在这里）
│       ├── ownership.ts  字段归属表（Record<keyof Application, Ownership>，编译期穷尽）
│       ├── engine.ts     plan() 五级去重与差异 / apply() 写入 / revertSync() 撤销
│       ├── capture.ts    三通道统一：JSON 信封 job-desk/capture@1 / 纯文本 / 文件
│       └── types.ts      MergePlan / PlannedRow / StagedSyncItem / SyncUndo
├── adapters/             纯解析：一个平台一个目录（types / registry / shared + boss|shixiseng|nowcoder|custom）
└── components/
    ├── TopBar TodoBar Toast Welcome
    ├── TodayView BoardView ListView CalendarView InsightsView
    ├── DetailDrawer QuickAdd SettingsDrawer
    ├── Field.tsx         通用输入控件（失焦即提交）
    ├── BulkBanner.tsx    批量操作提示条
    ├── MigrationFailPage.tsx  迁移失败三出口（不白屏）
    ├── sync/             RiskGate StagingList Step1Capture Step2Preview Step3Confirm badges SyncDrawer
    └── interview/        面经七件：QuickNote ExperienceEditor QuestionBank ReviewCards InterviewStats
                          InsightsTabs（[数据|面经] 二级切换）CommunityImport
```

### 两条结构硬规矩

1. **`lib/` 与 `adapters/` 不许 import React，也不许 import `storage`。**
   纯逻辑必须能在 node 环境单测；碰 DOM / localStorage 的只能是 `components/` 与 `App.tsx`。
2. **组件不直接改 state，全部走 `api.*`。** `AppApi` 是类型契约，组件只 `import type`，
   不给组件开 `setState` 的口子 —— 否则撤销快照会漏。

---

## 3. 数据与迁移

| 键 | 内容 |
| --- | --- |
| `localStorage['jobdesk.v1']` | 全量数据（`schemaVersion: 2`）：`settings / companies / applications / interviews / notes / experiences / questions / staging` |
| `localStorage['jobdesk.v1.ui']` | 上次视图（刷新还原） |
| `localStorage['jobdesk.v1.preMigrate.<ISO>']` | 迁移前回滚点，保留 30 天 |

**键名 `jobdesk.v1` 永远不改**（改了等于老用户数据消失）。schema 版本走数据内部的 `schemaVersion`。

迁移约束（改 `migrate.ts` 前必读）：

- 纯函数：时间从 `ctx.nowIso` 注入，**不读 `Date.now()`**。
- 只加不减：旧字段一个不删。
- 幂等：`migrate(migrate(x)) === migrate(x)`。
- v1 备份导入**走同一个函数**，不存在第二条没测过的升级路径。
- 审计写 `settings.lastMigration`（在 `settings` 下，**不在 `DB` 根上**）。

---

## 4. 样式约定

- 全部在 `src/styles.css`，**禁止 `style={{}}` 内联**（少数动态宽度用 CSS 变量传值）。
- 颜色 / 圆角 / 阴影只从 CSS 变量取（文件顶部 `:root`）。
- 类名用 BEM 风格：`sync__card--conflict`。新增模块先想前缀（`sync__` / `exp__` / `qb__` / `topbar__`），
  不要造新的一级命名空间。
- 窄屏断点只有两个：`900px` 与 `520px`。

---

## 5. 加东西之前

- **加一个平台** → 看 [`../docs/adapters/README.md`](../docs/adapters/README.md)（七步 + 脱敏要求）。
- **加一条产品语义映射** → 改 `lib/sync/statusMap.ts` 的 `STATUS_RULES`，**不要**改适配器。
- **给 `Application` 加字段** → 必须同时在 `lib/sync/ownership.ts` 的 `FIELD_OWNERSHIP` 声明归属，
  否则 `tsc` 会报错（这是故意的）。同步字段还要加进 `SYNC_WRITABLE`。
- **七条语义红线** → [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 第 2 节。改同步相关代码前请逐条对照。
