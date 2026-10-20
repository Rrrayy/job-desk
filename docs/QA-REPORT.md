# 求职工作台 · QA 验证报告

| 项 | 内容 |
| --- | --- |
| 被测对象 | `app/dist/index.html`（vite-plugin-singlefile 单文件构建；Round 1: 266.8 KB / Round 2: 271 KB / Round 3: 284,129 B → Bug-3 修复后 **284,198 B，2026-10-20 17:42 构建**） |
| 需求基准 | `docs/PRD.md` v1.0 + team-lead 拍板的 3 处口径变更（见 §10） |
| QA | Edward（software-qa-engineer） |
| 测试轮次 | **Round 1（完整验证）→ Round 2（修复回归）→ Round 3 定点复验（R-6/R-7/R-10，含 Bug-3 发现与修复复验）** |
| 最终结论 | **Round 3 复验 72 条全部通过（ROUTE: NoOne）。R-6 / R-7 / R-10 均已修复并验证，可以直接给学生用** |

---

## ⭐ Round 3 定点复验结论（最终状态）

工程师交付 R-6 / R-7 / R-10 三项后，针对新 dist 做的定点复验（Edge headless + CDP 真浏览器，截图 `docs/screenshots/r3-*.png`）：

**第一遍（dist 284,129 B）：57 条，53 PASS / 4 FAIL** —— 发现 **Bug-3：城市多选筛选不生效**（`ListView.tsx:142` 的 `rows` useMemo 依赖数组漏了 `cityFilter`；定位探针证实筛选逻辑本身正确、纯 memo 缓存过期）。
**第二遍（工程师修复后 dist 284,198 B）：72 条全部 PASS。**

| 项 | 结果 | 明细 |
| --- | --- | --- |
| R-6 轮次快选（已挂） | **PASS（25 条）** | 见下文 R-6 验证明细 |
| R-7 导出文件名本地日期 | **PASS（2 条）** | 实测导出文件名 = `求职工作台-备份-{本机当天}.json`（锚点 download 属性捕获法） |
| R-10 简历版本列 + 排序 + 版本筛选联动 | **PASS（10 条）** | 表头 9 列、第 5 列「简历版本」、点表头 ↓/↑ 双向有序、与版本下拉联动、清除筛选恢复 |
| R-10 城市多选筛选（Bug-3 修复复验） | **PASS（18 条）** | 见下文 |
| 回归烟雾（375px 不溢出、刷新保留） | PASS（4 条） | — |
| 合计 | **72 PASS / 0 FAIL / 72** | **ROUTE: NoOne** |

### R-6 验证明细（全部实测通过）
- 点「标为已挂」→ **状态先落库**（localStorage 立即 `status='rejected'`、`rejectedAtRound=null`），随后内联展开 5 个档位 chip（第 1/2/3 轮 / HR 面 / 不记得了）+「先不记」，全程有 toast「…不选也行」，**零阻塞** ✓
- 不选任何 chip：点「先不记」收起 / Esc 关抽屉 / 重开记录 → 状态仍是已挂、`rejectedAtRound=null` ✓
- 三个补录入口全部验证：① 抽屉顶部 chip（空值显示琥珀「轮次未记」，可点）；② 概览「轮次未记 · 点这里补录」链接；③ 列表状态列「轮次未记」/「第 2 轮」/「HR 面」小字 ✓
- 选「第 2 轮」→ 立即落库 `rejectedAtRound=2`，顶部 chip 与列表小字均显示「第 2 轮」；选「HR 面」→ 落库 **4**，展示层渲染为「HR 面」（顶部）/「第 4 轮（HR 面）」（概览），**没有裸露「第 4 轮」** ✓
- chip 高亮语义（工程师顺手补的）：**未记时无任何 chip 高亮**；显式点「不记得了」→ 落库 null 且该 chip 点亮，hint 显示「轮次未记」✓
- 联带回归：已挂后 `Ctrl+Z` 撤销 → 状态回滚为 applied 且 `rejectedAtRound` 一并回 null（`prevRejectedAtRound` 快照生效）✓

### R-10 城市多选 — Bug-3（已修复 · 已验证）
- **发现**（第一遍）：勾「北京」触发条变了但表格不过滤；多选显示「已选 2 个城市」也不过滤；点「清除筛选」后列表停留在旧筛选结果。定位探针：勾完城市后改动其他任一筛选条件，城市条件立刻生效（9→3）——证明逻辑正确、纯依赖数组遗漏。
- **修复**：`ListView.tsx:142` 依赖数组补上 `cityFilter`（工程师一行修复）。
- **复验**：勾北京 9→3 立即生效；筛选态下点表头排序不丢结果集（升/降序正确、↑↓ 箭头正确）；北京+上海=4、取消勾北京→只剩上海 1 条；城市+状态组合筛选行数与数据推导一致；「清除筛选」城市与状态一起归零；点空白收起面板后筛选仍生效。证据截图：`docs/screenshots/r3-05-city-multiselect.png`（已选 2 个城市 → 当前筛选出 4 条，与数据一致）。
- 修复前证据保留：`docs/qa-evidence/r3-57-results.txt`；修复后：`docs/qa-evidence/r3-72-results.txt`。

### 顺带确认
- 设置抽屉「沉默阈值覆盖」hint 已更新为「填了就是绝对阈值（不再乘渠道系数）；留空 = 全局阈值 × 渠道系数；最小生效 1 天，填 1 会当天标红」（dist 中含该文案，Round 2 报告的边界提醒闭环）。

---

## ⭐ Round 2 回归结论（最终状态）

工程师按 Round 1 报告修复了 2 个严重问题（Bug-1 两段式状态切换、Bug-2 按次撤销快照），并按 team-lead 拍板做了 3 处口径变更。回归结果：

| 层 | Round 2 断言 | 结果 |
| --- | --- | --- |
| 构建与类型 | tsc 0 错误；构建 271 KB 单文件 | PASS |
| 核心算法（含全部口径变更专项） | **138/138** | PASS |
| 真实浏览器（Edge headless + CDP） | **74/74** | PASS |
| 合计 | **212 条断言 0 失败** | **PASS** |

关键修复验证（全部实测）：
- **Bug-2 撤销**：拖卡改状态 → 面板写备注 → 撤销 → 状态回滚、system 记录精确删除、**用户备注保留**、note 净增 1；`Ctrl+Z` 走同一路径且不误伤其他投递的数据（单独按 Z 不触发撤销）。`revertStatusChange`（rules.ts:770）为纯函数，已单独断言 12 条。
- **Bug-1 两段式**：默认段=已投递（带解释文案）、想投段可见可点、切到想投后保存落 wishlist 且不写投递日期；看板每列列头新增「＋」，从「已沟通」列进入会带入该列状态。
- **口径①** `silenceOverride` 为绝对阈值（不再乘系数），warn = min(全局 warn, ceil(override×0.5))；override=1 时 warn/stale 撞在 1 天直接红（边界行为已记录）。
- **口径②** `needResult` 改回 PRD 20:00 口径：16:00 时今天那场仍在「今日面试」并显示「已结束，稍后记结果」，20:00 翻进「待记结果」，跨天一律进；`resultPromptHour` 可配（设为 1 时当场翻转验证）。
- **口径③** 老备份（无 `resultPromptHour`、schemaVersion 仍为 1）导入自动补 20；显式值被尊重；导出 round-trip 保留。

Round 2 中 QA 自身测试脚本的 3 处问题（headless 页面无焦点导致 blur 不派发 focusout、React 异步渲染时序、待办条目选择器命中红色沉默项而非蓝色面试项）均已自行修正，不涉及源码。

---

## 0. 验证环境

| 项 | 值 |
| --- | --- |
| 类型检查 | TypeScript 5.6.3，`tsc --noEmit`（strict 开启），**0 错误** |
| 构建 | Vite 5.4.21，50 modules，产物 `dist/index.html` 266.8 KB，**仅 1 个文件** |
| 产物自包含 | `grep` 确认无外部 `<script src>` / `<link rel=stylesheet>`，可 file:// 双击打开 |
| 浏览器实测 | Microsoft Edge（headless=new）+ CDP 直连（Node 22 内置 WebSocket，零第三方依赖），本地静态服务 `http://127.0.0.1:5199` |
| 屏幕规格 | 1440×900（桌面）与 375×812（窄屏）两套 |
| 时区 | GMT+8（中国标准时间）下做的日期专项验证 |
| 断言总数 | **算法层 115 条（全过）+ 浏览器层 98 条（96 过 / 2 真 Bug）= 213 条** |

> 测试方法说明：拖拽链路通过页面内合成 `DragEvent`（真实 `DataTransfer`，携带 app id）驱动 React 的 `dragstart/dragover/drop` 处理器，验证的是**应用的事件处理与状态机**，非操作系统级拖拽物理过程；键盘 Esc/Enter/N/数字键用 CDP 真实按键事件（`Input.dispatchKeyEvent`）驱动。

---

## 1. 第 1 层：构建与类型 —— PASS

| 用例 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- |
| `tsc --noEmit` | 0 错误 | 0 错误（strict 全开，无 `any`、无 `@ts-ignore`） | PASS |
| `vite build` | 成功 | 成功，50 modules，1.64s | PASS |
| 产物 | 单文件、无外部引用 | `dist/index.html` 266.8 KB，唯一文件，无外链 js/css | PASS |

---

## 2. 第 2 层：核心算法 —— 115/115 PASS

用 esbuild 打包 `src/lib` 真实实现后逐条断言（不复制逻辑）。按任务要求的 10 组覆盖点归类：

### 2.1 自然日边界（rules.ts `silenceStateOf`，阈值 >= 生效当天触发）
| 用例 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- |
| lastActivityAt = 今天 00:00 | 0 天 → null | null | PASS |
| 昨天 23:59 | 1 天 → null | null | PASS |
| 恰好第 2 天 | null | null | PASS |
| **恰好第 3 天当天** | **warn（变黄）** | warn | PASS |
| 第 6 天 | warn | warn | PASS |
| **恰好第 7 天当天** | **stale（变红）** | stale | PASS |
| 第 30 天 | stale | stale | PASS |
| 未来时间 | 不出负数 | 0 | PASS |

### 2.2 渠道系数（referral×3 / official×2 / 其余×1，warn 与 stale 都乘）
| 用例 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- |
| referral：warn/stale 阈值 | 9 / 21 | 9 / 21 | PASS |
| **applied + referral 沉默 8 天** | 见说明 | **null**（黄阈值也被 ×3=9，8 天连黄都不触发；21 天才红） | PASS* |
| referral 沉默 9 / 21 天 | warn / stale | warn / stale | PASS |
| **official 沉默 12 天** | 见说明 | **warn**（stale 阈值 = 7×2 = 14，不是 10；任务书里的「10 天就 stale」与 PRD 系数算不符） | PASS* |
| official 沉默 14 / 6 / 5 天 | stale / warn / null | stale / warn / null | PASS |

\* 任务书中两处预期（referral 8 天→warn、official 12 天→stale）与 PRD「阈值 × 渠道系数」的算法不符，**以实现为准判定 PASS**，见 §6 行为确认 B-1/B-2。

### 2.3 silenceOverride
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| override=10（boss）→ stale 阈值 10，沉默 10 天红、9 天黄 | 符合 | PASS |
| override=10 + referral → 实际阈值 30（**override 之后仍再乘渠道系数**） | 已记录，PRD 未明确，需产品拍板 | PASS（行为确认 B-3） |

### 2.4 interviewing / wishlist / 终态
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| interviewing 沉默 5 天 → stale（等结果阈值 5） | 符合，文案「等结果 X 天」 | PASS |
| interviewing 沉默 4 天 → warn | 符合 | PASS |
| wishlist 8 / 7 / 6 天 → 超期 8 / 7 / null | 符合 | PASS |
| wishlist / scheduled / offer / onboarded / rejected / dropped 沉默 30 天 → level 全为 null | 符合 | PASS |

### 2.5 lastActivityAt 派生 + 记一条即清零
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| 无 note 用 statusChangedAt；多 note 取最大；**忽略其他投递的 note** | 符合 | PASS |
| 红卡（9 天）新增 now 的 note → **立刻变 null** | 符合 | PASS |
| 状态变更后立刻 null | 符合 | PASS |
| 落库的 `lastActivityAt` 字段不参与派生（以 statusChangedAt+notes 实时计算，防止脏数据） | 设计合理 | 备注 |

### 2.6 示例数据：漏斗 / 待办 / 渠道 / 简历版本
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| 8 条投递、7 种状态 | 符合 | PASS |
| 漏斗 8/7/5/4/2/1，转化率 88%/71%/80%/50%/50% | 与手算一致 | PASS |
| 待办：stale 2（字节/美团）、warn 2（小红书/阿里）、想投超期 1（网易）、今天面试 1（腾讯） | 符合 | PASS |
| 待办排序 红>蓝>黄；stale 按天数降序 | 符合 | PASS |
| BOSS 渠道 3 投递 2 回复；内推 1 家 100% | 符合 | PASS |
| v3 版本 5 投递 3 进面 | 符合 | PASS |

### 2.7 冲突检测（rules.ts `findConflicts`）
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| 同日两场面试时间重叠（跨投递）→ 1 条提示，文案含「另一场面试」 | 符合 | PASS |
| 面试落进 courseSlots（周四 14:00-15:40《计算机网络》，14:30 开始）→ 提示含课程名 | 符合 | PASS |
| 同日不重叠 / 已取消 / 不同天 → 不报 | 符合 | PASS |
| 15:40 开始（正好接课程结束）→ 不算重叠（开区间） | 符合 | PASS |
| 示例数据阿里二面（下个周四 14:30）自动检出撞课 | 符合 | PASS |

### 2.8 导出→导入 round-trip 与校验
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| 导出→导入：公司/投递/面试/note 数量、公司名、岗位名、状态、设置、课程表、漏斗 **全部一致** | 符合 | PASS |
| 非法 JSON / 非法 status / 引用不存在的公司 / schemaVersion=2 → 全部拦下且报错可读 | 符合 | PASS |

### 2.9 localStorage 异常兜底（模拟写满/损坏）
| 用例 | 实际 | 结论 |
| --- | --- | --- |
| 空存储 → 空库 + 默认阈值 | 符合 | PASS |
| 存了坏 JSON → **不抛异常**，降级空库 + 「数据已损坏」提示 | 符合 | PASS |
| 结构非法（applications 不是数组）→ 降级 + 提示 | 符合 | PASS |
| setItem 抛 QuotaExceeded → `saveDB` 返回「保存失败…」字符串，界面有 banner 位 | 符合 | PASS |
| getItem 抛 SecurityError → 降级空库 + 隐私提示 | 符合 | PASS |

### 2.10 其他
- `parseFlexible('YYYY-MM-DD')` 按本地零点解析（UTC+8 下 00:00，而原生 `new Date('2025-03-05')` 是 08:00）→ **date.ts 无时区偏移问题**（专项验证见 §6 行为确认 B-4）。
- 已挂回推漏斗阶段：有面试→3（已约面），无面试有投递日→1。

---

## 3. 第 3 层：真实浏览器交互 —— 96/98 PASS

26 张截图存 `docs/screenshots/`。关键用例：

### S1 首次打开（8 项全过）
- 欢迎层出现，两个按钮「加载示例数据看看 / 我要自己记第一家」✓（`01-welcome.png`）
- 一键加载后 8 条投递 / 8 公司 / 7 状态；漏斗 8/7/5/4/2/1 ✓（`02-today.png`）
- 看板 6 列计数 **1/2/1/1/1/1**，进行中 7 张卡，已结束折叠列 1 条，展开可见快手 ✓（`03-board.png` `03b-board-ended.png`）

### S2 拖拽全链路（最高风险，9 项全过）
1. 把「美团」卡从已投递拖到已沟通 → 出现轻面板「已改为 已沟通」，**恰好 3 字段（日期/轮次/备注）** ✓（`04-drop-panel.png`）
2. toast「已更新 · 已投递 → 已沟通」带撤销按钮 ✓
3. **按真实 Esc 键** → 面板关闭，**状态仍生效**（列计数 已投递 1 / 已沟通 2）✓（`05-after-drop-esc.png`）
4. 自动写入一条 system 时间线「状态：已投递 → 已沟通」✓
5. **5 秒内点撤销** → 状态回滚 applied、system 时间线被清掉、note 总数复原 ✓（`06-after-undo.png`）

### S3 「⋯」兜底菜单（5 项全过，触屏唯一路径）
- 菜单可开、含全部 9 种状态、点「已挂」生效、菜单自动收起、同样可撤销 ✓（`07-kebab-menu.png`）

### S4 新增记录（8 过 / 1 FAIL）
- 回车即保存、自动建公司档案、保存后浮层保留提示「+1，继续记下一家」✓（`07-quickadd.png`）
- 缺公司名时 Enter 不保存、按钮禁用、提示「填公司名和岗位名」✓
- ❌ **S4-7 新记录默认落在「已投递」，PRD 要求默认「想投」**（详见 §5 Bug-1）

### S5 详情抽屉（12 项全过）
- 抽屉打开、标题、红色「已沉默 10 天」chip ✓（`08-drawer-stale.png`）
- **加一条备注 → 红色沉默标记立刻消失** ✓（`09-drawer-silence-cleared.png`）
- 「去催一下」自动生成话术（含公司名）+ 自动记一条 followup ✓（`09b-followup-script.png`）
- 删除需二次确认（「不能撤销」警告块）→ 取消可退、确认后**连带清掉时间线与面试** ✓（`10-delete-confirm.png` `10b-rejected-drawer.png`）
- 已挂记录展示「挂在第几轮 / 挂的原因」字段 ✓

### S5c 今日待办联动（2 项全过）
- 勾掉一条红色待办 → **待办条「N 家已沉默」实时减 1**，该条从「今天要做的」列表消失 ✓（`11-today-after-done.png`）

### S6 待办条 × 看板 × 列表 交叉核对（重点，6 项全过）
- 待办条沉默数 = 看板红卡数 = 列表红行数 ✓
- 待办条「该跟进」数 = 看板黄卡数 = 列表黄格数 ✓
- 列表总行数 = 8 ✓，待办 pill 齐全 ✓（`11-list.png`）

### S7 列表排序与筛选（7 项全过）
- 沉默天数点一次升序、再点降序 ✓
- 状态筛选「已挂」→ 只剩快手；渠道筛选「内推」→ 只剩腾讯；关键词「阿里」→ 1 行 ✓
- 筛选无结果 → 「这个筛选下没有公司」+ 清除筛选按钮，非空白 ✓（`11b-list-empty-filter.png`）

### S8 日历（4 项全过）
- 今天的格子标出腾讯 15:00 那场 ✓；月份头显示「7 场面试 · ⚠ 1 处时间冲突」✓
- 点冲突日 → 侧栏「⚠ 时间冲突」并写明撞的是《计算机网络》✓（`12-calendar.png`）

### S9 复盘（3 项全过）
- 漏斗 8/7/5/4/2/1 与今日视图一致；转化率文案齐全 ✓
- 渠道表 BOSS 3 家 2/3 回复；内推 100% 带「样本仅供参考」提示 ✓（`13-insights.png`）

### S10 设置（8 项全过）
- 改「已沉默（红）」7→1 → 设置落库、**看板红卡立刻 2→3**；改回 7 生效 ✓（`14-threshold-changed.png`）
- 导出 JSON 真实触发下载、内容合法（8 条投递 + settings/notes/interviews）✓
- 导入坏 JSON → 红色「导入失败」块给明确原因 ✓（`15-import-error.png`）

### S11 空数据（2 项全过）
- 清空后 5 个视图全部有引导文案，今日/看板/列表/复盘均带「下一步」按钮；日历给「这天没有面试」安抚文案 ✓（`16-empty-state.png`）

### S12 窄屏 375px（3 项全过）
- 页面无横向溢出（scrollWidth ≤ 376）✓
- 浮层、详情抽屉均占满屏宽不溢出 ✓（`17-narrow-empty.png` `17b-narrow-drawer.png`）

### S13 刷新持久化（3 项全过）
- 刷新后留在列表视图、8 条数据还在、不重复弹欢迎层 ✓（`18-after-reload.png`）

### S16 键盘快捷键（4 项全过）
- N 开「记一家」、Esc 关浮层/抽屉、数字键 3 切列表 ✓

### S14 全流程 JS 运行时异常
- 0 条（console.error / exceptionThrown / Log.error 全程监听）✓

---

## 4. 失败用例详情（Round 1 发现，Round 2 已确认修复）

### ✅ Bug-1（严重→已修复）：新增记录默认落「已投递」，PRD 要求默认「想投」
- **Round 1 现象**：只填公司名+岗位名回车，记录落在看板「已投递」列（`QuickAdd.tsx:17` 原为 `useState<Status>('applied')`）。
- **修复（team-lead 拍板为两段式切换）**：浮层顶部「想投 / 已投递」两段切换，默认已投递；看板每列列头加「＋」带入该列状态。
- **Round 2 回归**：S4-1~S4-9 共 9 条断言全过（默认段、一键切换、想投落库不写投递日期、列头＋带入、带入状态不被隐藏）。**CLOSED**。

### ✅ Bug-2（严重→已修复）：撤销会连带回滚「撤销之后」写入的备注（用户输入丢失）
- **Round 1 现象**：拖卡→面板写备注→点撤销，备注被一并删掉（note 13→11）；根因是 `App.tsx:84-103` 的整库快照回滚。
- **修复**：改为按影响面的按次快照（`StatusUndo` + 纯函数 `revertStatusChange`，rules.ts:755-779），撤销只删本次那条 system 记录、还原 4 个字段，其余数据一律不动。
- **Round 2 回归**：R7.1-R7.12（纯函数级）+ S2-5~S2-10 + S17-1~S17-4（Ctrl+Z 同路径、单 Z 不触发、不误伤他人数据）全部通过。**CLOSED**。

---

## 5. 第 4 层：代码审查（只列真实风险）

| # | 位置 | 发现 | 等级 |
| --- | --- | --- | --- |
| R-1 | 全局 | 无 `any`、无 `@ts-ignore`，`strict` 全开；写操作全部走 `mutate()` 深拷贝，状态/localStorage/撤销三处一致性好 | 亮点 |
| R-2 | `src/lib/storage.ts` | 读损坏/被禁/写满全部兜住且给「说人话」的降级提示（已实测），**不会白屏** | 亮点 |
| R-3 | `src/lib/date.ts:9` | 裸日期按本地零点解析，UTC+8 下实测 00:00（原生是 08:00），自然日差不会差一天 | 亮点 |
| R-4 | `src/App.tsx` | ~~撤销快照风险~~ **Round 2 已修复**：按次快照 `StatusUndo` + 纯函数 `revertStatusChange`，只删自己的 system 记录 | 已关闭 |
| R-5 | `src/lib/rules.ts` | ~~needResult 时机~~ **Round 2 已修复**：改回 PRD 20:00 口径（`resultPromptHour` 可配），当天面试结束先留「今日面试」并显示阶段文案 | 已关闭 |
| R-6 | `src/components/DetailDrawer.tsx` | ~~不强制选轮次~~ **Round 3 已修复并验证**：产品拍板改为「非阻塞快选」——标已挂先落库，内联 5 档 chip + 先不记，3 处补录入口齐全，chip 高亮语义清晰；QA 复验 25 条全过 | 已关闭 |
| R-7 | `src/App.tsx:431` | ~~导出文件名 UTC 早一天~~ **Round 3 已修复并验证**：改用本地日期 `todayISO()`，实测文件名 = `求职工作台-备份-{本机当天}.json` | 已关闭 |
| R-8 | `src/components/BoardView.tsx` | ~~绕过 parseFlexible~~ **Round 2 已顺手修掉**（工程师确认，回归未复现问题） | 已关闭 |
| R-9 | `src/components/QuickAdd.tsx` | 渠道默认 `'boss'`：product 决定不做，维持现状（渠道统计用例不受影响） | 关闭（不做） |
| R-10 | `src/components/ListView.tsx` | **Round 3 已交付，定点复验 28 条全过**：简历版本列（第 5 列，9 列表头、双向排序、与版本筛选联动）✓；城市多选（动态去重、条数徽标、未填城市、多选/取消/组合筛选/清除连带、点空白收起）✓。过程中发现并修复 Bug-3（`:142` 缺 `cityFilter` 依赖），修复后复验通过 | 已关闭 |
| R-11 | `src/lib/rules.ts:382` | 【Round 2 备注】`buildActionItems` 签名改为 `(todos, companies, settings, now)`—— breaking change，但全库唯一调用点 TodayView 已同步，tsc 通过，无实害 | 备注 |

---

## 6. 行为确认（Round 2 已全部敲定）

- **B-1** 渠道系数同时放大 warn 和 stale：内推 3 天×3=9 天才变黄（不是 3 天黄）。→ 已实现，回归通过。
- **B-2** official stale 阈值 = 7×2 = **14 天**（Round 1 任务书写的「10 天就 stale」与 PRD 系数算法不符，按 PRD 判 PASS）。→ 已实现，回归通过。
- **B-3** ~~override 之后仍乘渠道系数~~ → **Round 2 已按 team-lead 拍板改为绝对阈值**（不再乘系数），warn = min(全局 warn, ceil(override×0.5))；设置页 hint 同步更新。Round 2 算法断言含 20 条 override 专项（R4.1-R4.20），全过。
- **B-4** 时区专项（TZ=GMT+8 实测）：`parseFlexible('2025-03-05')` → 本地 00:00 ✓；以裸日期为 lastActivityAt 时 silenceDays 计算正确；~~导出文件名 UTC 偏差~~（R-7）**Round 3 已修复并复验**：文件名改用本地日期，与本机当天一致。

---

## 7. 遗留问题分级（Round 2 后）

| 级别 | 数量 | 条目 |
| --- | --- | --- |
| 阻断 | 0 | — |
| 严重 | 0 | Bug-1 / Bug-2（Round 2 修复）、Bug-3 城市筛选失效（Round 3 发现→修复→复验通过）均已闭环 |
| 已修复 · 已验证 | 5 | R-6 轮次快选、R-7 导出文件名、R-10 简历版本列+城市多选（Round 3 复验 72/72）；另有 R-8（Round 2 顺手修） |
| 关闭（不做） | 1 | R-9 QuickAdd 渠道默认 boss（product 拍板维持现状） |

---

## 8. 智能路由判定

```
Round 1: ROUTE: Engineer（Bug-1、Bug-2，含精确文件:行号与修复建议）
Round 2: ROUTE: NoOne（212 条断言 0 失败；3 处口径变更均为 team-lead 拍板的产品决策，回归全过）
Round 3（首验）: ROUTE: Engineer（Bug-3 城市多选失效，ListView.tsx:142；R-6/R-7/版本列 53/57 通过）
Round 3（修复复验）: ROUTE: NoOne（72 条断言 0 失败，含 chip 高亮语义与筛选态排序专项）
```

- Round 1 的两个失败用例断言均符合 PRD，是实现问题 → 交工程师，Round 2 已确认修复。
- QA 侧各轮中的测试脚本问题（React 异步渲染时序、夹具 statusChangedAt 未对齐、headless 无焦点导致 blur 不派发 focusout、待办条目选择器命中同公司的红色沉默项、触发条文案含 ▾ 尾巴、北京三行版本 tie 导致排序断言失真）均已自修，不涉及源码。
- Bug-3 的定位探针（勾完城市后改动其他筛选条件即生效）证明筛选逻辑正确、纯依赖数组遗漏，连同截图交给工程师，一轮修复即闭环。

---

## 9. 结论：能不能直接给学生用？

**可以。**（Round 3 修复复验后最终结论）

- ✅ 产品的灵魂——沉默判定全链路（自然日边界第 3/7 天当天恰好变黄/变红、referral×3/official×2、override 绝对阈值、interviewing 5 天、wishlist 7 天、三终态豁免、记一条立即清零）——两轮共 253 条算法断言全对，这是最容易做错的部分。
- ✅ 拖拽→3 字段面板→Esc 状态生效→撤销回滚（且不再吞用户输入）这条最高风险链路完整可用；⋯兜底菜单、键盘快捷键、待办条三视图计数一致性、日历撞课标《计算机网络》、复盘漏斗、导入导出（含老备份无感升级）、空态引导、375px 窄屏、刷新持久化全部通过；三轮全程 **0 运行时异常**。
- ✅ Round 1 的两个严重问题（新增默认状态、撤销吞备注）已修复并逐条回归确认；Round 3 的「已挂轮次快选」实现质量很好（先落库、零阻塞、三个补录入口齐全、HR 面=4 的编码约定正确渲染、chip 高亮语义清晰）。
- ✅ Round 3 过程中发现的唯一缺陷 Bug-3（城市多选不生效）已一轮修复并复验通过（72/72）。
- 开放项仅 R-9（product 已决定不做，关闭）。无遗留问题。

---

## 10. Round 2 口径变更记录（team-lead 拍板，QA 已按新口径回归）

| # | 变更 | 新行为 | 回归用例 |
| --- | --- | --- | --- |
| ① | `silenceOverride` 改为绝对阈值 | `effectiveStale = override`（不再 ×3/×2）；`effectiveWarn = min(warnAfterDays, ceil(override×0.5))` | R4.1-R4.20 |
| ② | `needResult` 改回 PRD 20:00 口径 | `pending && 已过 && (日期早于今天 || 今天且 now >= resultPromptHour)`；中间时段留在「今日面试」并显示「面试进行中 / 已结束，稍后记结果」 | R8.1-R8.15、S17b-1~6 |
| ③ | 新增 `AppSettings.resultPromptHour = 20` | `schemaVersion` 仍为 1；老备份缺字段导入自动补 20；设置页暂无此项 UI（localStorage 可配） | R11.7-R11.10、S10-5/S10-6 |
| ④ | 新增默认状态两段式 | 「想投/已投递」切换，默认已投递；看板列头「＋」带入列状态 | S4-1~S4-9 |
