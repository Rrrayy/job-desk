# 求职工作台 v0.2 · QA 验证报告

- **验证人**：严过关（QA）
- **被验版本**：`app/package.json` `version: 0.2.0`，`dist/index.html` sha256 `6fbc5b54…d0821`（424,919 字节）
- **验证方式**：全部独立执行，**不采信工程师自述**。每个结论都能复现（命令 / 探针 / 截图 / 浏览器实机操作）
- **仓库根**：`F:/简历/求职工具/job-desk/`
- **结论**：**不合格，退回工程师**。有 1 个阻断级数据丢失缺陷、3 个严重缺陷。

---

## 0. 环境

| 项 | 值 |
|---|---|
| OS | Windows 10（Git Bash） |
| Node | v22.22.2（`C:\Users\rr\.workbuddy\binaries\node\versions\22.22.2-6`） |
| 浏览器 | Edge `Edg/155.0.4283.62`（headless=new + CDP 9333，`--remote-allow-origins=*`） |
| 浏览器驱动 | 自写极简 CDP 客户端（Node 22 内建 WebSocket，`.qa-tmp/cdp.mjs`），不依赖 agent-browser |
| 打开方式 | `file://` 协议双击 `app/dist/index.html`（与学生真实使用方式一致） |
| 业务代码 | **未改动**。`app/src/lib/util.ts`、`app/dist/index.html`、`community/*.json` 三个校验和与基线一致；`app/src` 与干净副本 `diff -rq` 无差异 |

> 说明：任务书提到的 Windows vitest EPERM 本机**没有出现**，129 个用例一次跑通，工程师的串行规避方案未启用。

---

## 1. 执行摘要

| 环节 | 结果 |
|---|---|
| 硬关卡（tsc / test / no-network / build / bundle / community / CI-YAML） | **7 / 7 PASS** |
| 变异测试（证明检查真的会红） | **4 / 4 有效变红**，还原后校验和与基线一致 |
| 迁移探针（纯函数，脏 v1） | **32 / 32 PASS** |
| 存储/回滚探针（含配额模拟） | **44 / 44 PASS** |
| 同步引擎探针（语义红线） | **49 / 52**，3 FAIL |
| 浏览器实机（1440px + 375px） | **78 / 95 PASS**，17 FAIL |
| 开源工程性（干净目录重建 / .gitignore / LICENSE / README / 扩展静态审查） | **8 / 8 PASS**（1 处占位符待改） |
| 代码审查 | 未发现 `any` 滥用型崩溃风险；发现 1 处 effect 无依赖数组 |

**17 个浏览器 FAIL 收敛到 6 个根因**，其中 1 个阻断、3 个严重、2 个一般。

---

## 2. 硬关卡（真实输出，非转述）

```
npx tsc --noEmit                → EXIT=0
npm test                        → 11 个测试文件 / 129 passed / EXIT=0
npm run check:no-network        → 扫描 77 个文件 · 规则 8 条 → ✓ EXIT=0
npm run build                   → dist/index.html 404.36 kB（424,919 B）
npm run check:bundle            → 415 KB（415.0 KB / 上限 600 KB，占 69%）✓ EXIT=0
npm run validate:community      → 5 个文件 · 5 篇面经 · 32 道题 ✓ EXIT=0
```

CI 配置（`.github/workflows/ci.yml`）：

- `npx --yes yaml-lint` → `√ YAML Lint successful`
- js-yaml 解析结果：1 个 job `verify`、`runs-on: ubuntu-latest`、matrix node `['18','20']`、`working-directory: app`
- 10 个步骤顺序正确：checkout → setup-node → `npm ci` → `tsc` → `test` → `check:no-network` → `build` → `check:bundle` → `validate:community` → upload-artifact
- **fail-fast 有效**：`continue-on-error` 出现 **0 次**，`if:` 条件 **0 个**（没有把检查写成"跑但不算失败"），`upload-artifact` 带 `if-no-files-found: error`

---

## 3. 变异测试（工程师本轮没做，我逐条证明"检查会红"）

| # | 变异动作 | 期望 | 实际 | 还原校验 |
|---|---|---|---|---|
| 1 | 在 `app/src/lib/util.ts` 末尾加 `fetch('https://example.com')` | 非 0 退出 + 打印 file:line | `EXIT=1`，输出 `app/src/lib/util.ts:86  [fetch] 浏览器 fetch` | sha256 `9d3adfd1…b134` = 基线，复跑 `✓` |
| 2 | 把 `dist/index.html` 补到 610 KB | 非 0 退出 | `EXIT=1`，`610 KB（610.0 KB / 上限 600 KB，占 102%）✗ 超出红线` | sha256 `6fbc5b54…d0821` = 基线 |
| 2b | 把产物补到 480 KB（警戒带） | 只警告、不失败 | `EXIT=0`，`⚠ 已过警戒线：480 KB > 450 KB` | 同上 |
| 3 | 删掉面经笔记的 `companyName` | 非 0 退出 + 指名文件 | `EXIT=1`，`boss-bytedance-fe-intern-2025-03.json#1: 缺少 companyName` | sha256 `b3daf883…aa4` = 基线 |
| 3b | 写 260 字超长 + `13812345678` | 两条都报 | `EXIT=1`：`#1.questions[0]: text 超过 200 字`、`#1.questions[1].myAnswer: 疑似包含手机号：「13812345678」` | 同上，复跑 `✓` |

**结论**：三个检查脚本都不是"只会绿"的摆设。变异后 100% 变红，且定位信息（文件、行号、字段路径）可直接照着改。

---

## 4. 迁移（按真实老库的脏数据造）

探针：`.qa-tmp/probe-migrate.ts` / `.qa-tmp/probe-storage.ts`（esbuild 打包成独立进程跑，不进 `app/src`）

### 4.1 脏值保真（32 / 32 PASS）

| 脏输入 | 迁移结果 | 判定 |
|---|---|---|
| `silenceOverride: 0` | `0`（**没有**被当成 falsy 丢掉） | PASS |
| `silenceOverride: null` | `null` | PASS |
| `tags: ''`（字符串不是数组） | `[]` | PASS |
| `jdUrl: null` | `undefined` | PASS |
| `nextActionAt` 缺失 | `null` | PASS |
| `rejectedAtRound: null` + `status:'rejected'` | 原样保留 | PASS |
| `priority: 0` | `undefined`（不"纠正"成 3，仅丢弃非法值） | PASS |
| `updatedAt` 缺失 | 填 `ctx.now`（唯一允许的补值） | PASS |
| 空 notes 数组 / 缺 `settings.sync` | 补 `sync: {...DEFAULT, statusMapOverrides:{}}`，原 `settings` 字段全保留 | PASS |
| 条数 | companies 8→8、applications 8→8、notes 11→11、interviews 7→7 | PASS |

- **幂等**：同一个 `ctx.now` 跑两次，`JSON.stringify` 结果逐字节相同
- **已 v2 输入**：`changed:false`，对象同一引用、未被改写
- **未来版本**（`version:9`）：拒绝并给出升级提示，不进入主界面
- **纯净性**：`migrateV1ToV2` 不读 `Date.now()`/DOM——传入两个不同的 `ctx.now` 只有"缺失时间戳"字段跟着变，其余完全一致

### 4.2 回滚点（44 / 44 PASS）

- 迁移前写入 `jobdesk.v1.preMigrate.<ISO>`，内容**就是原始字符串**，能被 v1 校验器重新读出来（`silenceOverride:0` 完好）
- 指针 `jobdesk.v1.migration` → `status:'done'`
- 反复刷新：**只迁移一次**（回滚点始终 1 个）
- 配额被占满导致回滚点写不进去：迁移**中止**，原 key 不动，**不写指针**（契约 5 成立）
- 30 天清扫只清自己前缀的 key
- v1 备份文件经「设置→导入」：成功、4 条投递、补 3 个新数组、与启动迁移结果深相等（除 `lastMigration`）

### 4.3 失败路径（这里挖出阻断级缺陷，见 §8 D4）

失败页本身**存在且不白屏**：三种出口齐全（① 下载原始 JSON ② 重新读取 ③ 用空数据进入），原因写得很具体（`投递「前端」引用了不存在的公司（c_missing）`）。截图：`docs/screenshots-v0.2/14/15`。

**但是**：失败页出现的同时，`jobdesk.v1` 已经被覆盖成空库 —— 详见 D4。

---

## 5. 同步引擎（语义红线，逐条实测）

探针：`.qa-tmp/probe-sync.ts`（49 PASS / 3 FAIL）

| # | 红线 | 结果 |
|---|---|---|
| 1 | 五计数器守恒 `新增+更新+无变化+冲突+待归类 === 识别条数` | **PASS**，三组数据（全新 / 全同 / 混合）全部成立，如混合组 `{new:2, update:1, unchanged:0, conflict:1, staged:2}` |
| 1b | 行 key 唯一、冲突行默认不勾选 | **PASS** |
| 2 | 解析失败**不准静默丢弃** | **FAIL → D1** |
| 3 | 无变化不写笔记：20 条沉默记录同步一次 | **PASS**，`notes` 数量不变、每条 `lastActivityAt` 不变、`silenceLevel` 不变，只刷新 `lastSyncedAt` 心跳 |
| 4 | `lastActivityAt` 只取 max、不准回退 | **PASS**，平台 `lastContactAt` 比本地旧时保持 `2025-03-10` 不缩水 |
| 5 | 「邀请面试」不准越界 | **PASS**，映射为 `chatting`、**不是** `scheduled`、**不新建** Interview，只发「去约时间」提醒 |
| 6 | 去重稳定 + 改了 `jobTitle` 后仍不重复 | **PASS**，两次同步后仍 1 条；用户改标题后靠 `matchKey` 命中，改过的标题不被覆盖（D-08） |
| 7 | 字段归属（`FIELD_OWNERSHIP` 逐字段） | **PASS**，`user-only` 字段全部保住；`set-once` 的 channel 只在首次写 |
| 8 | 撤销：删新增、回滚改动、**不删用户手写笔记** | **PASS**，`applications/notes/companies` 与合并前逐字节相同，手写笔记内容完整 |
| 9 | 同一条无法归类的记录同步两次 | **PASS**，暂存区不堆积、永不写进主库 |

### 补充（浏览器复核同一批语义）

- 风险门：未勾选时「开始同步」`disabled=true`；勾选后可点
- 四步向导可达：① 抓取（平台选择 + 粘贴框 + 解析）② 预览（五分类齐全）③ 确认（批量勾选）④ 结果
- 合并后 toast 带「撤销」，撤销一次全部回滚（含手写笔记）
- 详情抽屉「来源：BOSS 直聘 同步 · 10/20 20:19 · 平台原文「已投递」」正确渲染

---

## 6. 浏览器实机（file:// 双击，1440px / 375px）

截图目录：`docs/screenshots-v0.2/`（29 张）

### 6.1 通过的关键路径

- 首次打开：欢迎页正常，无白屏、无 CORS；示例数据 8 条落盘为 v2
- 五视图全部可切换且有内容：今日 / 看板 / 列表 / 日历 / 复盘
- 今日页「**3 场面试待复盘**」卡片出现（新功能）
- 复盘二级 tab `[数据][面经]` 存在，「面经」上有待复盘红点
- 看板拖拽「已投递 → 已沟通」成功，toast「已更新 · 已投递 → 已沟通 / 撤销」，单步撤销可回到原状态
- 列表：状态筛选 10→2 行、渠道筛选 10→1 行、「清除筛选」复原、点表头「沉默天数」升/降序切换
- 日历：7 场面试、`⚠ 1 处时间冲突` 提示
- `⌘K`/`Ctrl+K` 聚焦搜索框，输入「美团」命中「美团 · 到店事业群 前端实习生 / 已沟通」
- `Esc` 关闭详情抽屉
- 快记：**Enter 连记 10 题**，列表 10 条、连记后光标不回跳、写入 `db.questions` 10 条、关闭时「已记 10 题 · 2026-10-21 提醒复习」
- 导出 Markdown：真实生成 Blob（1,620 字），有 `#`/`##`/`###` 层级、「来源：我自己记的（`self`）」
- 375px：详情抽屉 / 同步抽屉 / 快记浮层都不越界（表格在容器内 `overflow-x:auto`，正常）
- 持久化：刷新后**视图保留**（复盘→复盘）、**二级 tab 保留**（面经→面经）；连续刷新 4 次回滚点仍为 1 个（迁移只发生一次）

### 6.2 脱敏矩阵（「导出时脱敏」默认勾选）

| 输入 | 结果 |
|---|---|
| `13812345678` | ✅ → `138****0000` |
| `zhangsan@example.com` | ✅ → `z***@example.com` |
| `15k` / `30万` / `300元/天` | ✅ → `<薪资>` |
| `张三面试官` / `李四老师` | ✅ → `面试官` |
| **`200/天`** | ❌ **未脱敏** |
| **`王面试官`** | ❌ **未脱敏** |
| **`王老师`** | ❌ **未脱敏** |

---

## 7. 开源工程性

| 项 | 结果 |
|---|---|
| 干净目录重建 | **PASS**：`tar --exclude=node_modules --exclude=dist` 拷出 925 K → `npm ci`（102 包，1 分钟）→ `npm run build` → 单个 `dist/index.html` 404.36 kB，sha256 **与仓库内产物完全一致**。README 的"3 步启动"是真的 |
| `.gitignore` | **PASS**：`app/dist/index.html` **未被忽略**（会提交，与 README 说明一致）；`node_modules/` 命中第 2 行；`jobdesk-备份.json` 命中 `jobdesk*.json`；`.env` 命中；`community/*.json` 仍被跟踪。试提交 193 个文件，无 node_modules |
| LICENSE | **PASS**：MIT 原文 + 一段非许可性质的说明脚注；`community/` 另有 CC BY-SA 4.0（`community/LICENSE`），`package.json` `"license": "MIT"` 一致 |
| CHANGELOG | **PASS**：`[0.2.0] - 2025-03-12` 与 `version: 0.2.0` 对齐，且诚实记录了 1.0.0→0.2.0 的降版 |
| README 路径 | **PASS**：12 个引用路径全部存在 |
| **`package.json` 占位符** | ❌ `repository.url` / `homepage` 仍是 `github.com/OWNER/job-desk` |
| 扩展静态审查 | **PASS**：`permissions` 恰好 `["activeTab","scripting"]`，无 `host_permissions`、无 `tabs`、无 `cookies`；`content.js` 零 `fetch`/`XMLHttpRequest`；`popup.js` 有 `navigator.clipboard` → `legacyCopy`（textarea + `execCommand`）兜底；`selectors.json` 与 `content.js` 的 `SELECTORS` 逐字段一致（version `2025-03-01`，三平台 hosts+cards 齐全） |

---

## 8. 缺陷清单（按严重度）

### 🔴 阻断 · D4｜数据损坏时，失败页出现的同时把用户原数据覆盖成空库

**这正是失败页承诺"绝不会发生"的那件事。**

失败页组件自己的文件头注释写着（`app/src/components/MigrationFailPage.tsx:3`）：

> 铁律：**绝不写任何 storage key**，原数据一字不动

页面上还写着（同文件 `:36`）：

> 你的原始数据**没有被修改、也没有被删除**

**实际行为**：`App.tsx:191-194` 有一个无条件的落盘 effect：

```ts
// app/src/App.tsx:190-194
useEffect(() => {
  const error = saveDB(db);
  setSaveError(error);
}, [db]);
```

`loadDB()` 在所有失败分支都返回 `db: emptyDB()`（`app/src/lib/storage.ts:104-114` 非 JSON、`:137-147` v2 校验失败、以及 v1 迁移失败分支）。失败页的 early-return 在 `App.tsx:1054`，但 effect 早就注册了，于是 **mount 后立刻把 485 字节的空骨架写进 `jobdesk.v1`**，原始数据被覆盖。

实测（浏览器，1440px）：

| 场景 | 注入后 `jobdesk.v1` | 失败页出现后 | 再刷一次 |
|---|---|---|---|
| v2 数据里某条 note 缺 `touchedAt` | **12,057 字节**（含标记 `QA_MARK_7788`） | **485 字节，标记消失** | 失败页不再出现，直接变成空白应用 |
| 非 JSON 原始串（2,039 字节） | 2,039 字节 | **485 字节，标记消失** | 同上 |
| 无效 v1（引用不存在的公司，533 字节） | 533 字节 | 485 字节，但回滚点 `jobdesk.v1.preMigrate.<ISO>` 里还有 533 字节原文 | 失败页不再出现 |

**后果分级**：

- **v2 损坏 / 非 JSON**：没有任何回滚点（`backupKey: null`），**刷新一次即永久丢失**。用户手里只剩内存里的下载按钮，一旦刷新就没了。
- **v1 无效**：回滚点能救，但失败页第三条路「重新读取」会把用户从"看得到错误"直接送到"空白应用"，且刷新后警告消失 —— 用户会以为数据本来就没有。
- 同时「③ 用空数据继续」的文案「注意：这一次不要新建投递 —— 一旦保存，浏览器里会写入一份新的数据」已经过时：**数据早就写进去了**。

**复现步骤**：`file://` 打开 `dist/index.html` → 点「加载示例数据看看」（8 条）→ DevTools 里 `const d=JSON.parse(localStorage.getItem('jobdesk.v1')); delete d.notes[0].touchedAt; localStorage.setItem('jobdesk.v1',JSON.stringify(d)); location.reload()` → 失败页出现 → 读 `localStorage.getItem('jobdesk.v1').length` = **485**（原本 12,057）。

截图：`14-fail-page-v2-corrupt-1440.png`（失败页与 485 字节同时存在）、`15-fail-page-v1-invalid-1440.png`

**建议修法**：`saveDB` 的门槛提到"拿到合法 db 之后"，例如 `useEffect(() => { if (boot.migration?.failed && !emptyContinue) return; ... }, [db])`，或者在 `boot.db` 为 `emptyDB()` 且 `migration.failed` 时先 `bootRef` 拦一道；另外失败页的三条出口都应先把 `raw` 复制到 `jobdesk.v1.failedAt.<ISO>` 再允许任何写操作。

---

### 🟠 严重 · D1｜解析失败的条目**没有**落进「待归类」，而是被静默丢弃（违背 PRD §B.9 P0）

- 引擎 `plan()` 固定返回 `unparsed: []`（`app/src/lib/sync/engine.ts:431`），`apply()` 里唯一往 `next.staging` 写的地方是 `:719`（只处理 `plan.rows` 里的 `staged` 行），**没有任何路径把 `plan.unparsed` 落库**。
- `App.tsx:495-535` 的 `planSync` 明明把适配器的 `unparsed` 合并进了 plan（`{...plan, unparsed: [...parsed.unparsed, ...plan.unparsed]}`），但下一步没人消费它。

**浏览器实机自相矛盾（两屏之隔）**：

- 第 2 步预览（`Step2Preview`）：`1 条没解析出来（不会丢，会进「待归类」）` —— 截图 `11-sync-preview-1440.png`
- 第 4 步结果：`写入 4 条 · **没有遗留待归类记录**`，暂存区显示「没有待归类的记录 / 同步时没能自动判定的记录会放在这里 —— 一条都不会丢」 —— 截图 `13-sync-result-1440.png`
- 实测 `db.staging`：合并前 0 → 合并后 **0**

也就是说：**同一份数据，前一步承诺"不会丢"，后一步宣称"没有遗留"，实际丢了。** 这直接踩中 PRD §B.9 P0「解析出错的条目**一定**落进「待归类」，不被静默丢弃」。

复现：粘贴文本里放两块无公司名的内容（`已投递 / 昨天` 和一段 44 字的长句）→ 解析 → 预览显示"1 条没解析出来" → 确认合并 → `JSON.parse(localStorage.getItem('jobdesk.v1')).staging.length === 0`。

---

### 🟠 严重 · D3｜勾选「冲突」行等于什么都没做，却往用户时间线写一条自相矛盾的状态记录

- 冲突行的 `changes` 恒为 `[]`（`engine.ts:338 / 390 / 413` 等），所以 `apply()` 的 `for (const change of row.changes)` 循环空转，**状态不会被写**。
- 但 `statusChanged` 的判定是 `row.mappedStatus !== null && row.mappedStatus !== previousStatus`（`engine.ts:634`），对冲突行恒为 `true`，于是笔记门槛 `if (!statusChanged && !timeRefreshed) continue;` 放行，写出：

```
平台同步：状态 已发 Offer → 已发 Offer（BOSS · 平台时间 3/12 10:20）
```

实测（本地 `已发 Offer` + 用户手改标记，平台 `邀请面试` → `已沟通`）：

- 预览：`冲突 / 已发 Offer → 已沟通 / 你 10/20 20:35 手动改过状态，平台数据更旧 / **不写入** / 你手改过，默认不覆盖`
- 用户勾上这一行 → 结果页「写入 4 条」
- 合并后 `status` 仍是 `offer`（这部分行为正确），但时间线多出一条 **「已发 Offer → 已发 Offer」**

截图：`29-bogus-sync-note-1440.png`

两个问题叠加起来是：**UI 让用户勾选一个"不写入"的行，勾了之后没有正向效果，只留下一条自己打自己脸的时间线。** 用户会以为同步坏了。

建议：冲突行（`changes: []`）在 `Step3Confirm` 里直接禁用勾选，或勾选后真正写入用户选择的平台状态；同时 `statusChanged` 必须改为"确实发生了状态变化"（比较 `previousStatus` 与实际写入值），不能用"平台映射值与本地不同"来判定。

---

### 🟠 严重 · D6｜「导出时脱敏」漏掉最常见的三种情况（默认还是勾选状态）

`app/src/lib/interviewMarkdown.ts:20-32` 的三条正则：

```ts
.replace(/\d+(?:\.\d+)?\s*(?:k|K|元|万)(?:\s*\/\s*[天月年])?/g, '<薪资>')   // 注释里写着支持「200/天」，但没 200/天 分支
.replace(/[\u4e00-\u9fa5]{2,3}(?=面试官)/g, '')                            // 要求 ≥2 个汉字
.replace(/[\u4e00-\u9fa5]{2,3}老师/g, '面试官')                            // 要求 ≥2 个汉字
```

| 输入 | 期望 | 实际 |
|---|---|---|
| `200/天` | `<薪资>` | **原样输出** |
| `王面试官` | `面试官` | **原样输出** |
| `王老师` | `面试官` | **原样输出** |

`200/天` 是实习岗最常见的薪资写法；`王面试官`/`王老师` 用**单字姓**，而百家姓里绝大多数是单字（王李张刘陈杨黄赵吴周…）。也就是说：**这个功能在自己的主要使用场景上失效**，而开关默认勾选、按钮上写着「导出时脱敏」，用户会据此把内容直接发到牛客/小红书。

同上文件 `:4` 的注释明确写「薪资数字（200/天、15k、30万）」，所以连注释与被注释对象都不一致。

### 🟡 一般 · D5｜375px 下顶栏溢出 66px，主 CTA「＋ 记一家」被挤出屏幕

`app/src/styles.css:162` 的 `.topbar__right` 是 `flex-wrap: nowrap`，`@media (max-width:900px)`（`:4407`）只让 `.topbar` 换行、给 `.topbar__right` 设了 `width:100%`，但**没让它内部换行或收缩**。

375 CSS px 实测：

```
.topbar__right 宽 332，子项：search 219 + 同步 66 + ⚙ 27 + ＋记一家 85（含 gap）
→ button.btn--primary「＋ 记一家」left=356 right=441
→ document.scrollWidth = 441，横向溢出 66px
```

五个视图**全部**横向滚动 66px。截图 `24-375-*.png`。抽屉、快记浮层、表格（`overflow-x:auto`）都正常，问题只在顶栏一处。

（如果移动端不是 v0.2 的目标，可降级为"建议"；但只要有人用手机打开就会看到横向滚动条。）

### 🟡 一般 · D7｜列表筛选条件刷新后不保留

`loadUIView/saveUIView` 只存 `{view, insightsTab}`：刷新后视图和二级 tab 都在（`{"view":"insights","insightsTab":"interview"}`），但列表的状态/渠道/简历版本筛选与排序全部回到默认。属于设计取舍，但与"筛选是否保留"的验收期望不一致，记录下来由产品或架构拍板。

### 🔵 建议 · D8｜`package.json` 仍是占位符

`repository.url`、`homepage` 都是 `github.com/OWNER/job-desk`。公开到 GitHub 前必须替换。

### 🔵 建议 · D9｜`ReviewCards.tsx` 的 `useEffect` 没有依赖数组

`app/src/components/interview/ReviewCards.tsx:48-63` 的 keydown 监听每次渲染都重新订阅/解绑。功能正确（不会漏解绑），但每次渲染都做一次 DOM 操作。本轮 `useMemo`/`useCallback` 依赖数组全量扫了一遍（40+ 处），**没有发现上一轮 `ListView` 那种缺依赖的同类问题**。

---

## 9. 三分结论（明确区分"我验过 / 验不了 / 验坏了"）

### ✅ 我验过且通过

- 三个检查脚本的**有效性**（变异测试 4/4 真的会红）
- 脏 v1 迁移的**保真与幂等**（32 项）、回滚点可重读、只迁移一次
- 同步引擎的语义红线：五计数器守恒、沉默记录不写笔记、`lastActivityAt` 只增不减、邀请面试不越界、去重稳定、字段归属、撤销不删手写笔记
- `file://` 双击可用、五视图、看板拖拽、⌘K、Esc、列表筛选排序、日历撞期、导入导出
- 四步同步向导、复盘二级 tab、今日"待复盘"卡片、详情"来源"行
- 快记连录 10 题、题库筛选、导出 Markdown 的真实内容
- 干净目录 `npm ci && npm run build` 产出与仓库逐字节相同
- `.gitignore` 不会误吞 `dist`、也不会误提交 `node_modules`
- 扩展的权限声明与 `content.js` 无网络请求（静态审查）

### ⛔ 验过但失败（必须修）

D4（阻断）、D1、D3、D6（严重）、D5、D7（一般）

### ❓ 本机无法验证（不敢替工程师签字）

1. **真实 BOSS 页面 DOM**：我没有真实登录态账号，所有粘贴内容都是我按 `shared.ts` 的启发式手写的仿真文本。`selectors.json` 与 `content.js` 一致、扩展只读 `innerText`，但"真实虚拟滚动列表里 Ctrl+A 能抓到几条"只能靠用户反馈。
2. **扩展在真实 Chrome 里的加载**：`agent-browser install` 下载 Chromium 时 TLS 中断（`chrome-for-testing-public/.../chrome-win64.zip` 三次重试均失败），只能用 Edge headless 跑 `file://` 页面，**没有真的 `chrome://extensions` 加载 unpacked 扩展**。静态审查通过 ≠ 能装上。
3. **真实 v0.1 老库**：我没有真实用户半年的 localStorage。脏数据是按 PRD/架构里列出的每一种脏形态构造的（`silenceOverride:0`、`tags:''`、`priority:0`、缺 `updatedAt` 等），覆盖度应该够，但"真实世界里还有没有我们没想到的脏法"只能靠 beta 用户。

---

## 10. 两个独立结论

### 能不能公开到 GitHub？

**技术上可以，但建议先修 D8（OWNER 占位符）再公开**，否则 README 里的链接全是死的。

其余开源要素是扎实的：干净目录 3 步能跑起来且产物逐字节可复现、`.gitignore` 区分得对（`dist` 故意提交、`node_modules` 不提交、备份 JSON 不泄漏）、LICENSE 与 `package.json` 一致、`community/` 有独立的 CC BY-SA 4.0、CI 是 fail-fast 的、扩展权限克制（只要 `activeTab + scripting`）。

### 能不能直接给学生用？

**不能。** 理由只有一条，但足够：

**D4 —— 学生的数据可能被自己的工具删掉，而且是无声的。** 一个 localStorage 里的 JSON 只要有一条不对（手动改过、写一半断电、浏览器同步冲突），打开工具会看到失败页，然后**同一个瞬间**原始数据被覆盖成空库；v2 场景下刷新一次就永久没了。目标用户是正在找工作、没有任何技术背景的学生，他们不会去 DevTools 里找 `jobdesk.v1.preMigrate.*`。

其次是 D1：产品在两步之间自己打自己脸（"不会丢"→"没有遗留"→ 真的丢了）。这破坏的是"这个工具可以信任"的地基 —— 而这个工具卖的就是"把你的求职记录安全地放在你自己电脑上"。

修完 D4 + D1，再修 D3、D6，我认为可以给学生用。

---

## 11. 复现方式与证据

所有探针与浏览器脚本都是验证期间临时写的，**验证结束后已按约定删除**（`.qa-tmp/` 整目录清理，未进入仓库）。以下复现步骤不依赖任何被删除的文件：

**环境**：Node 22 + Edge/Chrome（headless 即可，`--remote-debugging-port` 打开 CDP）。

- **关卡与变异**：直接跑 `app/package.json` 里的脚本；变异动作见 §3 表格，改完必须还原。
- **迁移 / 存储**：用 esbuild 把一段独立脚本打成 CJS 后 `node` 执行（脚本内 import `app/src/lib/migrate.ts`、`storage.ts`、`rollback.ts`，用 `globalThis.localStorage` 挂一个带配额模拟的假存储）——**不要**把探针放进 `app/src`。
- **浏览器实机**：CDP `Page.navigate` 打开 `file://.../app/dist/index.html`，`Runtime.evaluate` 用原生 setter 写表单值再派发 `input`/`change`（React 受控组件必须走 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`）；375px 用 `Emulation.setDeviceMetricsOverride {width:375, mobile:false}`（`mobile:true` 会触发 shrink-to-fit，把真实溢出隐藏掉）。
- **关键复现**（都在 §8 各缺陷条目里）：
  - D4：改坏一条 note → reload → 对比 `localStorage.getItem('jobdesk.v1').length`（12057 → 485）
  - D1：粘贴含无公司名块 → 预览 vs 结果页 vs `db.staging.length`
  - D3：把某条投递改成 `offer` + `userEditedAt.status`，再用含「邀请面试」的文本同步，看时间线
  - D6：把 `13812345678` / `200/天` / `王面试官` 写进 `myAnswer`，勾选「导出时脱敏」导出比对
  - D5：375px 下 `document.documentElement.scrollWidth` = 441

截图证据保留在 `docs/screenshots-v0.2/`（33 张）。关键对照：

| 证据 | 文件 |
|---|---|
| D1「不会丢」 vs「没有遗留」 | `11-sync-preview-1440.png` ↔ `13-sync-result-1440.png` |
| D4 失败页与 485 字节空库并存 | `14-fail-page-v2-corrupt-1440.png`、`15-fail-page-v1-invalid-1440.png` |
| D3 自相矛盾的时间线 | `29-bogus-sync-note-1440.png` |
| D5 375px 顶栏溢出（＋记一家被截断 + 底部横向滚动条） | `24-375-今日.png` 等 5 张 |
| 正常路径 | `05~09`（五视图）、`10~13`（同步向导）、`18`（来源行）、`22`（快记 10 题）、`26~28`（375px 抽屉/浮层） |

> 业务代码未改动：`app/src/lib/util.ts` `9d3adfd1…b134`、`app/dist/index.html` `6fbc5b54…d0821`、`community/boss-bytedance-fe-intern-2025-03.json` `b3daf883…aa4` 三个校验和验证前后一致；`app/src` 与干净副本 `diff -rq` 无差异。

---

# 12. 第二轮回归（工程师修复后 · 2026-10-20 晚）

范围：只回归第一轮 7 个缺陷（D4/D1/D3/D6/D5/D7/D8）+ 修复可能引入的新风险，不重跑全量。
方法与第一轮相同原则：**不跑工程师写的测试来当证据**，全部独立造数据、独立断言。
本轮共 **478 条断言，0 FAIL**（探针 245 + 浏览器实机 233）。

## 12.0 硬关卡（修复后重跑）

| 关卡 | 结果 |
|---|---|
| `npx tsc --noEmit` | EXIT=0 |
| `npm test` | **12 文件 / 156 用例全绿**（5.93s） |
| `check:no-network` | 78 文件 × 8 规则 ✓ EXIT=0 |
| `npm run build` | `dist/index.html` 411.08 kB = **432,853 B**（与工程师自述字节数完全一致） |
| `check:bundle` | 423 KB / 上限 600 KB（70%），WARN 450 · FAIL 600 ✓ |
| `validate:community` | 5 文件 · 5 篇 · 32 题 ✓ |

## 12.1 D4（阻断）—— 7 条逐条结论，全部 PASS

修法复核：闸门下沉到 `storage.ts` —— `loadDB()` 在返回失败结果的**那一刻**就 `lockPersistence()`（`storage.ts:180`），`saveDB` 见锁直接返回（`:351`）；读失败前先把 raw 另存 `jobdesk.v1.failedAt.<ISO>`（`preserveFailedRaw`，`:103`，幂等 + 上限 3 份丢最旧）；`App.tsx:1082` 渲染失败页时再上锁一次（双保险），`App.tsx:1113` 正常路径每次渲染解锁。这个修法是对的：**不再赌「effect 与 return 谁先跑」**，上一轮的洞是从根上封的。

| # | 用例 | 结果 |
|---|---|---|
| 1 | v2 损坏（真实 `buildSampleDB` 造 14,027 B 健康库 → 删第 1 条 note 的 `touchedAt`）→ 失败页出现 → `jobdesk.v1` 字节数/字数/sha256/逐字节四项全部不变；模拟「effect 先跑」连调 `saveDB(emptyDB())` ×3 仍不变；**刷新 5 次全部仍是失败页且每次都一字未变**；failedAt 副本只 1 份（幂等） | **PASS** |
| 2 | 非 JSON（`{{{坏的`）→ 失败页 + 原因「不是合法的 JSON」；5 次刷新原文不变 | **PASS** |
| 3 | v1 损坏（缺 companyId）→ 失败页；`jobdesk.v1.preMigrate.*` 回滚点写出且内容 = 原始 v1 字符串，3 次刷新后仍完整可读 | **PASS** |
| 4 | 「下载原始 JSON」真实点击，`Browser.setDownloadBehavior` 落盘取回文件：**sha256 与 `jobdesk.v1.failedAt.<ISO>` 完全一致，逐字节相同** | **PASS** |
| 5 | 失败页上所有 `<code>` 显示的 key（`jobdesk.v1`、`jobdesk.v1.failedAt.2026-10-20T13-07-13-836Z`、preMigrate key）**逐个与 localStorage 里真实存在的 key 比对，全部一致**，用户照着去 DevTools 找不会扑空 | **PASS** |
| 6 | 点「用空数据进入」→ 主界面出现；`saveDB` 返回 null（写成功）；新数据落盘且**刷新后还在**（闸门真的解锁了）；`failedAt` 副本全程未被覆盖 | **PASS** |
| 7 | **反向**：正常数据启动不上锁 —— 正常路径 `saveDB` 成功、修改真的写进 localStorage；正常 v1 → v2 迁移仍然落盘（闸门没把成功路径也锁死，`writeDB` 直通），写回 `schemaVersion=2` + `lastMigration` | **PASS** |

浏览器实机三种损坏场景（v2 缺字段 / 非 JSON / v1 损坏）合计 65 条断言全绿，截图 `30/40/41-r2-*.png`。上一轮「12,057 B → 485 B」的事故路径已复验为「14,027 B → 14,027 B（不变）」。

## 12.2 D1（严重）—— PASS

独立造 3 段垃圾（有状态没公司 / 半截卡片 / 纯符号，各带一行时间防被合并）走完 **真实 UI 四步同步**：

- ② 显示「**3 条没解析出来**（不会丢，会进「待归类」）」，④ 显示「**3 条留在暂存区待归类**」，`db.staging` 里 `reason==='unparsed'` **3 条** —— 三处数字相等（上一轮 1 vs 0 vs 0）。
- 落库条目字段齐全：`rawSnippet`（原文片段）、`reasonText`（失败原因）、`platform`、`capturedAt` 全在；`parsed.companyName` 是空串，**没有编出「未知公司」投递**（`applications.length` 不变，`written=0`）。
- 带着这 3 条 staging 的库能过 `validateImport` 往返（`validateV2` 白名单已加 `unparsed`，注释里明确写了这是 D1 的直接后果）—— 否则下次启动会把自己刚写的库判成坏数据。
- 重复粘贴同一批 → 仍是 3 条（不是 6 条）；忽略一条 → 剩 2 条，UI 标题「暂存区（2）」，TopBar 红点 = 2。
- 待归类行 UI：`--unparsed` 行内 **0 个状态下拉**，只有 复制原文 / 手动补录一条 / 忽略这条，且每行解释「为什么没认出来」+ 显示平台与时间（截图 `32-r2-*.png`）。

## 12.3 D3（严重）—— PASS（独立重跑 24 组矩阵 + 补 2 组）

- **24 组矩阵**（本地 scheduled/chatting/applied × 平台 已发 Offer/沟通中/已投递/邀请面试 × 勾/不勾）独立重跑：所有 conflict 行 `defaultChecked=false`；不勾 → 状态保持本地值、`statusChangedAt` 不动、**一条 note 都不写**、进暂存（reason=conflict）；勾 → 状态被平台覆盖、暂存清空、note 是真的「旧 → 新」。
- **「A → A」全局扫描 = 0 条**（上一轮 `29-bogus-sync-note-1440.png` 那条已消失）。修法复核：`engine.ts:652` 改成「**写入之后**与写入之前比较」（`target.status !== previousStatus`），比修 `changes` 数组更根治 —— 就算以后有人再改坏 changes，这里也不会再写出假记录。
- **补组 A**：平台原文「系统维护中」（映射不出）→ `kind=staged`、`mappedStatus=null`、勾不勾都 0 写入 0 note，进「待归类」。
- **补组 B**：本地终态 `rejected`（`rejectedAtRound: 2`）+ 平台「邀请面试」→ `conflict`（user-edited）**默认不勾**；不勾 → 仍是「已拒绝」、`rejectedAtRound: 2` 原样保留、0 note；勾了才变「沟通中」且**不造 Interview**，note「已拒绝 → 沟通中」两侧不同。
- 浏览器实机走真实 UI：不勾合并 → `status` 仍是 scheduled、notes 数不变；勾上再合并 → `平台同步：状态 已约面 → 已发 Offer（BOSS · 平台时间 3/12 10:20）`（截图 `34-r2-*.png`）。

## 12.4 D6（严重）—— PASS（10 正例 + 7 反例 + 1 个取舍判定）

- 正例 10/10 全脱：`200/天`（新增 `SALARY_WITH_PERIOD`）、`15k`、`30万`、`8千`、`30w`（单位白名单加了 `w/千`）、`王面试官`（姓名改**姓氏白名单**，单字姓不再要求 ≥2 字）、`王老师`、`李总`（`nameBeforeZong`）、`王哥`、`赵姐`（`nameBeforeSibling`）。
- 反例 7/7 零误伤：`前端`、`后端`、`一面`、`二面`、`项目`、`项目总共三期`（`项` 是姓，但 `项` 后面是 `目` 不是 `总`）、`这项总结`（`总` 后是 `结`，被 `ZONG_BLOCK` 排除）。
- 真实段落混排：`一面是王老师…200/天…李总…15k…30w…赵姐说王哥会跟进` → 姓名/薪资全部替换，`项目总共三期`/`一面/二面` 原样保留。
- **「X 面」规则的取舍判定：工程师不做是对的，不判 FAIL。** 用假想正则 `[姓][\u4e00-\u9fa5]?面` 做了对照实验：能脱掉「张三面的我」，但同时把「项目面问的是八股」削成「面问的是八股」—— 而真正的泄露大头是「王磊问了很多八股」这种**裸姓名**（没有称呼锚点），正则做不到，需要 NER。记为**已知限制**（建议级，见 12.8），不判缺陷。

## 12.5 D5（一般）—— PASS（真视口三档）

用 CDP `Emulation.setDeviceMetricsOverride {mobile:false}`（上轮的教训：`mobile:true` 会 shrink-to-fit 把溢出藏掉）压真视口：

| 档位 | 结果 |
|---|---|
| **375px** | 五视图 + 同步抽屉 + 速记浮层 + 待复盘卡片：`scrollWidth=360 = clientWidth=360`（360 = 375 − 15px 滚动条），**无横向溢出**；「＋ 记一家」rect `[260,130,346,164]`，右边缘 346 ≤ 375，`elementFromPoint` 命中按钮自身（**可点**）；顶栏右缘 346（上轮是 441，溢出 66px，已修） |
| **768px** | 同上全套 0 溢出，无回归 |
| **1440px** | 同上全套 0 溢出，无回归 |

修法复核：`styles.css:162` `.topbar__right` 加 `flex-wrap: wrap; min-width: 0`，`:4439` 窄屏媒体查询同步补了容器内换行。截图 `35-r2-375-今日.png`（「＋ 记一家」完整可见）等 5 视图 + `36/37`（375px 抽屉/浮层）。

## 12.6 D7（一般）—— PASS（含反向风险）

- 六项筛选（状态/渠道/简历版本/城市/关键词/排序）一起存 `jobdesk.v1.listFilters`（独立 key，不污染主库）；UI 设 `chatting + boss + 北京 + 前端` → **刷新后六项全保留、行数不变**。
- 脏缓存①`{"statusFilter":123,"cityFilter":"x"}` → `sanitizeListFilters` 整份回默认，列表 = 全量（**没有筛成空**）；脏缓存②`{"status":"not-a-status","cities":"x","keyword":123,"sortKey":"evil","sortDir":"up"}` → 类型收敛 + ListView 白名单兜底，仍全量。探针另验：非对象/null/数组/数字 → null 回默认；keyword 截 100 字、cities 截 40 个。
- **反向**：点「清除筛选」→ 缓存立即回默认 → 刷新后不残留（状态 all、关键词空、行数 = 全量）。

## 12.7 D8（建议）—— 已按「模板仓库」方案关闭

`package.json` 的 `OWNER` 占位符**没有被替换，而是被显式声明为刻意的**：README.md:67 说明这是模板发布、指向 `docs/RELEASE-CHECKLIST.md` 第 1 条（🔴 替换 OWNER，并列出了需要改的全部位置）。对「模板 + fork 发布」的定位来说这个处理成立 —— 判 PASS，但**如果将来以真实名义发布，仍必须先跑一遍清单第 1 条**。

## 12.8 顺手确认（防修复引入新问题）

- **迁移成功路径仍能落盘**：探针场景 8 + 浏览器（示例数据 8 条落盘 → 刷新还在 → 列表筛选可持久化）双向验证，闸门没有误伤正常写入。
- **新组件 useMemo/useCallback 依赖扫描**：`StagingList.tsx:39` `[items]` ✓；`SyncDrawer.tsx:53` `[plan]` ✓；`ListView.tsx:76` 的 `useEffect` 七项依赖齐全 ✓；`MigrationFailPage` 只有 useState，无依赖问题。**未发现上轮 ListView 那类漏依赖**。
- 本轮我自己的 3 个测试错误（已修正，不计入结论）：① probe-d4 断言把「字符数/字节数」混在一个字符串里比对；② D1 探针的垃圾文本没带时间行，被 `chunkByTrailingTime` 合并成 2 块；③ b-d1 的标题选择器取到了「④ 已合并」。

## 12.9 第二轮汇总

| 项 | 数字 |
|---|---|
| 探针（esbuild 打包独立运行） | D4 84 · D1 42 · D3 48 · D6 30 · D7 41 = **245 断言 0 FAIL** |
| 浏览器实机（Edge headless + CDP，真视口） | D4 65 · D1 24 · D3 20 · D5 99 · D7 25 = **233 断言 0 FAIL** |
| 硬关卡 | 6/6 PASS（156 单测全绿） |
| 缺陷 | D4/D1/D3/D6/D5/D7/D8 **全部关闭**；遗留仅建议级：裸姓名（无称呼锚点）不脱敏（需 NER，正则不可达） |

## 12.10 第二轮结论

- **ROUTE：NoOne** —— 7 个缺陷全部真实修复，无回归，无新引入问题。
- **能不能公开到 GitHub：可以。** 六关卡全绿、`OWNER` 已按模板方案文档化（发布前走 RELEASE-CHECKLIST 第 1 条即可）。
- **能不能直接给学生用：可以。** 上一轮的一票否决项 D4（失败页静默毁数据）已从根上修复并经三种损坏场景 + 5 次刷新 + 下载逐字节比对验证；「邀请面试不造 Interview」「不勾不动状态」「解析失败不静默丢」等语义红线全部实测通过。

### 第二轮截图（新增 17 张，共 50 张）

| 证据 | 文件 |
|---|---|
| D4 失败页 + 页面显示的 key 与真实 key 一致 | `30-r2-d4-fail-page-1440.png` |
| D4 非 JSON / v1 损坏 | `40-r2-d4-nonjson-fail-1440.png`、`41-r2-d4-v1corrupt-fail-1440.png` |
| D4 用空数据进入后主界面可写盘 | `31-r2-after-empty-continue-1440.png` |
| D1 待归类 3 条（无状态下拉、带原文与原因） | `32-r2-d1-staging-unparsed-1440.png` |
| D1 TopBar 红点 = 暂存数 | `33-r2-d1-topbar-dot-1440.png` |
| D3 勾选冲突后正确的时间线「已约面 → 已发 Offer」 | `34-r2-d3-conflict-checked-note-1440.png` |
| D5 375px 五视图无溢出 | `35-r2-375-{今日,看板,列表,日历,复盘}.png` |
| D5 375px 抽屉/浮层 | `36-r2-375-sync-drawer.png`、`37-r2-375-quicknote.png` |
| D7 筛选设置 / 刷新后保留 | `38-r2-d7-filters-set-1440.png`、`39-r2-d7-filters-after-reload-1440.png` |

> 复现：D4 用「改坏一条 note 的 `touchedAt` → 刷新 5 次 → `localStorage.getItem('jobdesk.v1')` 长度与 sha256 每次都和改坏后一致；下载按钮的文件与之逐字节相同」；D1/D3 用 `docs/screenshots-v0.2/` 对应截图里的操作路径重放即可。第二轮探针与浏览器脚本同为临时文件、跑完即删，关键步骤已全部写进本节。
