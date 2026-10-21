<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img src="assets/banner-light.svg" alt="求职工作台 Job Desk" width="100%">
</picture>

**本地优先的求职投递工作台。**

用一个 HTML 文件管理投递管线：今日待办、看板、沉默提醒、截止倒计时、日程冲突、面经复盘。

[下载](#安装) ｜ [设计取舍](#设计取舍) ｜ [架构](#架构) ｜ [工程质量](#工程质量) ｜ [English](README.en.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Rrrayy/job-desk/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Rrrayy/job-desk/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Rrrayy/job-desk?style=flat-square)](https://github.com/Rrrayy/job-desk/releases/latest)
![tests](https://img.shields.io/badge/tests-320%20passed-2ea44f?style=flat-square)
![bundle](https://img.shields.io/badge/bundle-480%20KB-4c6ef5?style=flat-square)
![requests](https://img.shields.io/badge/runtime%20requests-0-2ea44f?style=flat-square)
![schema](https://img.shields.io/badge/schema-v2-845ef7?style=flat-square)
[![license](https://img.shields.io/github/license/Rrrayy/job-desk?style=flat-square)](LICENSE)

</div>

> **投了 50 家之后，你还记得哪家该催、哪家面试在今天、哪家已经沉默两周了吗？**
>
> 这是它唯一想解决的问题。一家公司一条线，一屏回答「现在做什么」。它不是招聘聚合器，不做简历生成，也不代替你投递。

<br>

<img src="assets/demo.gif" alt="演示：加载示例数据 → 今日待办 → 打开详情一键催进 → 看板 → 日历冲突 → 搜索直达" width="100%">

<sub>真实录屏，21 秒：加载示例 → 打开红色待办的详情 → 一键催进（顶栏沉默计时当场清零）→ 看板 → 日历抓出「面试 × 组会」双向冲突 → 搜索「小红书」直达详情。</sub>

---

## 概览

一个求职投递的生命周期有两条容易失控的线索：**对方多久没理你**，和**外部世界给了你什么期限**。这两件事一旦混在一起，就会互相掩盖 —— 前者被「我昨天刚记了一笔」冲淡，后者被「我觉得还好」忽略。

Job Desk 把这两条线分开建模：沉默天数从活动时间派生，截止日期是独立的三态字段，待办清单由两者合并生成，顺序固定（截止先算，静音后压）。这就是整个应用的骨架，其余功能都是它的延伸。

| 约束 | 做法 |
| :--- | :--- |
| 运行时零网络请求 | 无 fetch / XHR / beacon / WebSocket，无 CDN，无第三方字体；CI 静态扫描，命中即红 |
| 单文件、双击即用 | 构建产物是一个 `index.html`，`file://` 直接跑，不需要 Node 或本地服务 |
| 数据不出本机 | 浏览器本地存储单一主键，导入导出走本地文件下载 |
| 崩溃不丢数据 | 渲染异常进兜底页；读取失败先备份原文再锁定写入 |
| 依赖最小 | 运行时仅 `react` + `react-dom`；无路由库、状态库、UI 库、日期库、IDB 库 |

适用场景：日常实习、暑期实习、秋招、春招、提前批、校招、社招 —— 只要你在投简历，这个模型就成立。

## 安装

### 直接下载（推荐）

到 [Releases](https://github.com/Rrrayy/job-desk/releases/latest) 下载 `index.html`，双击打开。不需要 Node，不需要起服务。

```
index.html      一个文件，约 480 KiB
  ├─ 双击       file:// 直接运行
  └─ 换个地方   拷到 U 盘、发给自己，照样能开
```

### 从源码构建

```bash
git clone https://github.com/Rrrayy/job-desk
cd job-desk/app
npm install && npm run build
open dist/index.html        # macOS；Windows 直接双击，或 start dist\index.html
```

### 开发模式

```bash
cd app && npm install && npm run dev   # http://localhost:5173
```

> 首次打开会让你选择「加载示例数据看看」（8 家公司、7 种状态）或「我要自己记第一家」。
> 清空用 设置 → 数据 → 回到初始状态。

### 可选：浏览器扩展

`extension/` 是一个零构建的 MV3 扩展，用来抓取当前招聘页面的文本，省掉 `Ctrl+A / Ctrl+V`。未上架商店，走「加载已解压的扩展程序」。

扩展**不做解析**，只产出信封：

```json5
{ "format": "boss", "url": "…", "title": "…", "capturedAt": "…", "text": "…" }
```

信封交给与粘贴通道**完全相同**的那份解析代码，所以解析器只需要维护一份。

## 功能

### 五个视图

| 视图 | 回答的问题 |
| :--- | :--- |
| 今日 | 今天有几场面试？谁该催了？哪家明天截止？ |
| 看板 | 50 家分别卡在哪个阶段（想投 → 已投 → 沟通中 → 面试中 → 结果） |
| 列表 | 按沉默天数排序，最凉的排在前面 |
| 日历 | 面试、课表、私事同框，冲突精确到分钟 |
| 复盘 | 漏斗转化、简历版本命中率、每周投递量；二级 tab 是面经 |

卡片上直接显示你写的最新一条记录（随手记 / 沟通 / 催问），不用点开详情就能想起上次聊到哪。

### 判定与提醒

四类提醒不是同一件事，它们落在同一张表的不同格子里：

```
               截止远 ──────────────────── 截止近
               ┌────────────────────┬────────────────────┐
沉默短         │ 无需动作             │ 正常在流程里         │
               │ 外部期限             │ 还没到催的时候       │
               ├────────────────────┼────────────────────┤
沉默长         │ 该催了               │ 一键生成话术         │
               │ 今天截止             │ 压过静音，必须看     │
               └────────────────────┴────────────────────┘
```

- **沉默判定**：阈值按渠道放大（内推 ×3、官网 ×2），offer 阶段单独监控且不乘系数；单独设过阈值的投递不受系数影响
- **截止倒计时**：已过期 / 今天 / 3 天内三级；截止项不能一键划掉，只能打开详情确认
- **静音**：落点是「第 N 天 23:59:59」，只压软提醒，压不住硬截止 —— 也就是上表右下角
- **冲突检测**：面试 × 面试 × 课 × 私事放进同一个池子两两比对，同一天且 `HH:mm` 区间精确重叠才报
- **催进话术**一键生成；公司 + 岗位即可建档，3 秒一家

### 面试与面经

- **多轮次建模**：每轮一张卡片，带准备清单、形式、结果；挂了记在第几轮
- **快记**：一行一题，`Enter` 连记，90 秒 5 题
- **题库**：公司 / 分类 / 掌握度 / 到期 / 关键词五维筛选，按「不会的先复习」排序
- **复习卡**：间隔复习，标完掌握度自动重排下次时间
- **统计**：「哪类题最容易挂」（分母是挂掉的场次数）、公司高频题 Top 5
- `community/` 收录真人面经（CC BY-SA 4.0），离线导入，产品不会替你发起网络请求

### 数据

- **回收站**：删除的投递留 30 天，第 27 天提醒；面试与沟通记录跟着一起留，恢复后绑定完整
- **增量导入**：只补缺，不覆盖这一周新记的内容；两边值不同逐条列差异让你裁决，简历版本与优先级永远保留本地值
- **备份形式**：JSON（唯一能完整导回的格式）、便携包 zip（含应用本体 + 数据 + 校验和，对方解压双击即可查看）、CSV 投递表、ICS 日历
- **平台同步**：BOSS 直聘 / 实习僧 / 牛客 / 通用表格，粘贴列表后比对差异、逐条确认、整次可撤销
- **课表导入**：一行一节课，识别不了的行给出原因；只替换课程类日程，手动记的事不受影响
- **存储自动升级**：`file://` 用 localStorage；`http(s)` 探测到 IndexedDB 时优先使用，突破 5 MB 上限

## 设计取舍

功能列表哪里都能看，取舍才是这个项目的样子。每条选择都附上代价。

### 截止与沉默是两条正交的轴

「对方多久没理我」和「外部世界给我的期限」是两件事，混在一起就会互相掩盖。

> **做法**　`deadlineAt` 用三态语义 —— 未设置（继承）/ `null`（显式关闭）/ 日期（覆盖）；截止项不可一键划掉
>
> **代价**　多一个字段、多一套校验。`??` 在这里是陷阱（它把 `null` 与 `undefined` 合并，而两者含义正好相反），因此校验必须走 `asTriStateDate()`

### 静音压得住软提醒，压不住硬截止

「今天不想被这个 App 催」是合理需求，但「明天网申截止」不该被算法藏起来。

> **做法**　静音落在「第 N 天 23:59:59」而非 `now + N×24h`；待办生成时**截止计算排在静音判断之前**
>
> **代价**　静音中的投递仍可能出现今日待办里（如果它快截止了）。这是故意的

### 日历是通用日程表，不是面试日历

现实中撞车的从来不只是面试 —— 组会、体检、临时急事都会撞。

> **做法**　`db.events` 单表存所有日程（`kind` 区分课程与私事，`weekly` 按周几 / 单次按日期）；冲突条件是「同一天 + `HH:mm` 区间重叠」（`a.start < b.end && b.start < a.end`），端点相接不算冲突
>
> **代价**　课表导入是替换语义，只替换 `course && weekly` 的日程；「手动记的事永不被覆盖」写成测试，而不是注释

### 撤销是栈，删除必须可撤销

单槽撤销等于没有撤销：手滑第二次就提示「没有可撤销的操作」。

> **做法**　10 步栈 + 重做；新操作清空重做栈；同步合并可撤不可重做（它的逆不是干净的逆）；撤销按次快照，绝不整库回滚
>
> **代价**　删除投递要额外记录被它带走的行（面试 / 时间线 / 面经绑定），恢复时还要处理「面经已被改绑到别人身上」—— 这种情况不抢回来

### 出事的时候必须有出路

界面崩了、数据读不出来、写盘失败 —— 这几种情况下用户不能被困住。

> **做法**　`ErrorBoundary` 给三个出口（重新加载 / 下载原始 JSON / 复制错误信息）；读取失败先把原文另存到 `failedAt.*`，再锁持久化，`saveDB` 直接 no-op
>
> **代价**　**禁止任何自动修复**。自动修复会把「可恢复」变成「不可恢复」，所以这个页面只给出口，不猜、不修、不删

### 一个 HTML 文件是可验证的约束，不是懒得拆

单文件的代价是体积天花板，收益是每一条承诺都能被机器检查。

| 承诺 | 实现 | 防回归手段 |
| :--- | :--- | :--- |
| 零网络请求 | 无 fetch / XHR / beacon / WebSocket，无 CDN | CI 静态扫描 11 条规则，白名单为空 |
| 单文件双击可用 | `vite-plugin-singlefile` + `base:'./'`，JS / CSS 内联 | 产物检查 + 体积红线 |
| 数据不出本机 | 单一主键存储，导入导出走下载 | CI 扫描 + 评审红线 |
| 数据损坏不丢 | 读取失败先备份原文，再锁定写入 | 三种损坏场景 × 多次刷新 |
| 撤销不吞数据 | 按次快照，纯函数回滚 | 单测覆盖 |
| 同步不骗沉默计时 | `touchedAt` 只用平台 `lastContactAt`；`lastActivityAt` 只走 `max()` | 同步引擎单测 31 条 |
| 迁移幂等可回滚 | 纯函数、只加不减、前置快照 | 迁移单测 11 条 + 迁移失败页 |

**代价**：体积硬红线 540 KB，功能不能无限加。这是刻意的约束。

### 不引第三方库的边界在哪

| 需求 | 常见选择 | 这里的选择 | 理由 |
| :--- | :--- | :--- | :--- |
| IndexedDB 封装 | Dexie | 约 60 行原生 IDB | 只需要一个 kv store；多一个运行时依赖就多一次体积与供应链成本 |
| 长列表窗口化 | react-window | 约 80 行纯函数 + 一个 hook | 需要的是「给定行高算区间」，而第三方组件的内部行为进不了单测 |
| ZIP 打包 | jszip | 约 90 行 store 模式实现 | 应用 HTML 已压过一遍，deflate 只再省约 5%；固定时间戳才能保证可复现 |
| 日期计算 | date-fns / dayjs | 手写自然日差 | 需要的只有「自然日差」与「第 N 天 23:59:59」两个语义 |

这条边界不是「一律不用库」，而是**只有当依赖的体积成本明显高于自写成本时才自写**，且自写的部分必须有单测。

## 架构

**技术栈**：Vite 5 + React 18 + TypeScript 5.6 strict。运行时依赖只有 `react` 与 `react-dom`。

```
localStorage / IndexedDB
        │  readSync / loadDBAsync
        ▼
   validateV2  ──►  迁移（纯函数、幂等、带回滚点）
        │
        ▼
    App.tsx   持有 DB，所有写操作走 mutate()（内置撤销快照）
        │  api.db 是「视图库」—— 回收站的行在这里被摘掉，全库唯一过滤点
        ▼
   视图派生（纯函数，全部不落库）
        │  沉默天数 · 待办聚合 · 漏斗统计 · 冲突检测 · 窗口区间
        ▼
    渲染 17 个组件，无 UI 库，一份带 CSS 变量设计令牌的 styles.css
```

**几条结构性决定**：

- **派生优先**：沉默天数、待办、漏斗、冲突全部由纯函数从 `DB` 算出。落库的派生值一定会和真实状态脱节
- **单一过滤点**：软删除不在 40 多个消费点逐处判断，而在构造 `api.db` 时摘掉 —— 逐处判断必然漏掉一个，而漏掉的那个会显示已删除的投递
- **存储后端抽象**：`StorageBackend` 接口 + 运行时探测。`file://` 直接用 localStorage 且不探测 IDB（主场景，多重试一次只拖慢首屏）；`http(s)` 才探测 IDB
- **解析与合并分离**：适配器是纯函数（文本 → 结构化记录），合并算法归维护者所有，新增平台 = 新增适配器 + fixture + 测试，不在引擎里加分支

完整数据模型、同步合并算法与字段所有权规则见 [`docs/ARCHITECTURE-v0.2.md`](docs/ARCHITECTURE-v0.2.md)。

<details>
<summary><b>📁 目录结构</b></summary>

```
job-desk/
├── app/
│   ├── src/
│   │   ├── App.tsx            # 状态中枢，所有写操作走 mutate()
│   │   ├── types.ts           # 数据模型（schema v2）
│   │   ├── adapters/          # 平台适配器 boss / shixiseng / nowcoder / custom（各带 fixture + 单测）
│   │   ├── lib/
│   │   │   ├── rules.ts       # 沉默派生、截止判定、待办聚合、漏斗、话术、冲突检测
│   │   │   ├── storage/       # 后端抽象：backend / idb / detect
│   │   │   ├── storage.ts     # 读写、校验、迁移入口、损坏上锁、配额
│   │   │   ├── sync/          # 同步引擎：normalize / statusMap / engine / capture
│   │   │   ├── trash.ts       # 回收站：软删除、到期扫描、单一过滤点
│   │   │   ├── merge.ts       # 导入增量合并、字段所有权、冲突计算
│   │   │   ├── portable.ts    # 便携包 ZIP（store 模式、可复现）
│   │   │   ├── virtual.ts     # 列表窗口化：区间计算 + hook
│   │   │   ├── migrate.ts     # v1 → v2 迁移（纯函数、幂等、只加不减）
│   │   │   ├── rollback.ts    # 回滚点与 30 天清理
│   │   │   ├── courseImport.ts# 课表文本解析（坏行给原因）
│   │   │   ├── tableExport.ts # CSV / ICS 导出（防公式注入、RFC 5545 折行）
│   │   │   └── interview.ts   # 面经统计与间隔复习
│   │   └── components/        # 视图 + 抽屉 + 面经 + 同步面板 + ErrorBoundary
│   ├── scripts/               # 类型 / 测试 / 体积 / 零网络 / 版本一致性 / 打包 / 基准
│   └── smoke-v05.mjs          # CDP 端到端冒烟
├── extension/                 # 可选 MV3 扩展（只 activeTab + scripting）
├── community/                 # 社区面经（CC BY-SA 4.0，离线导入）
├── docs/                      # PRD / 架构 / QA 报告 / 适配器指南 / 发布说明 / 截图
├── assets/                    # README 横幅与演示动图
└── CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  LICENSE
```

</details>

<details>
<summary><b>📐 核心算法：沉默判定</b></summary>

```
lastActivityAt = max(statusChangedAt, 该投递下所有 note.touchedAt)
silenceDays    = 今天（自然日零点）− lastActivityAt 的自然日差
```

- 阈值按渠道放大：内推 ×3、官网 ×2、其余 ×1；**单独设过阈值的公司不受系数影响**（填 10 就是 10 天）
- 沉默覆盖已投 / 沟通中 / 面试中 / 已发 Offer 四个状态；面试中用「等结果超时」，offer 用独立的 `offerSilenceDays`
- **任何一条时间线新增、任何状态变更，`lastActivityAt` 立刻刷新，红色自动消失** —— 不需要手动「取消沉默」
- 撤销只回滚那一次状态变更：之后你手写的备注、面试、设置都不会被吞

</details>

<details>
<summary><b>🗄️ 数据存在哪、怎么备份</b></summary>

| key | 内容 |
| :--- | :--- |
| `jobdesk.v1` | 全量数据：设置、公司、投递、面试、时间线、面经、题目、暂存区、日程 |
| `jobdesk.v1.ui` | 上次的视图位置 |
| `jobdesk.v1.listFilters` | 列表视图的筛选条件 |
| `jobdesk.v1.preMigrate.<时间>` | 迁移前的原始数据（回滚点，保留 30 天） |
| `jobdesk.v1.failedAt.<时间>` | 读取失败时的原始数据副本（最多 3 份，永不被覆盖修改） |

放到网页上访问时，同一份数据存在 IndexedDB 的 `jobdesk` / `kv` store 里，键名不变。

- 数据只在这个浏览器里：正常关闭、刷新、关机重启都在；清站点数据、无痕窗口、换浏览器或设备会丢
- **换电脑或清缓存前先导出**：设置 → 数据 → 导出 JSON（这是唯一能完整导回的格式）
- **想把应用一起带走**：导出便携包，zip 内含 `index.html` + `data.json` + 说明 + 校验和
- 设置页显示「上次备份：N 天前」，超 7 天标红。它会提醒，不阻止你做任何事

</details>

<details>
<summary><b>🔄 平台同步的边界</b></summary>

平台没有公开接口（就算有也不会给个人开发者用），所以这里做的不是爬虫，而是**读你自己屏幕上已经能看到的内容**：

```
① 抓取：整页 Ctrl+A / Ctrl+V，或用扩展一键抓
② 预览：五类计数（新增 / 更新 / 无变化 / 冲突 / 待归类）+ 差异表
③ 确认：逐条勾选，冲突行默认不勾
④ 结果：写入了多少条、多少条进了暂存区
```

- **只有第 ④ 步写库**，前三步返回上一步不产生任何副作用
- 时间线只用平台给的**最后联系时间**，绝不用抓取时刻 —— 否则每同步一次，沉默计时就被骗着清零一次
- 平台「邀请面试」只映射到「沟通中」+ 一条待办，不会自动排面试、不会自动造面试记录
- 没有变化的记录不写时间线；认不出的记录进暂存区，一条都不丢，逐条给原因
- 五类计数守恒：新增 + 更新 + 无变化 + 冲突 + 待归类 === 识别条数。少一条就是 bug

新增平台请参考 [`docs/adapters/README.md`](docs/adapters/README.md)，每个适配器都有 fixture 和单测。

</details>

<details>
<summary><b>🔒 隐私与不做的事</b></summary>

这个项目最硬的一条承诺：**打开页面，浏览器不会为它发出任何请求。**

- 没有统计、没有埋点、没有第三方字体、没有 CDN、没有「检查更新」
- `npm run check:no-network` 静态扫描 `app/src` 与 `extension/`（11 条规则，含 CSS `url()` / `@import` / `<link href>`），命中直接让 CI 失败；白名单默认是空的 —— 空不是还没填，空就是真的一个都没有

明确不做的事（不是排期问题，是产品定位）：

- 账号系统与云同步 —— 一旦有服务器，「一个请求都不发」就成了谎话
- 自动登录招聘平台、自动投递、后台常驻或定时抓取
- 把单文件产物拆成需要起服务的应用
- 简历生成与招聘聚合

</details>

## 工程质量

`npm run verify` 跑七道关卡，任何一道红就不许合并。

| # | 关卡 | 命令 | 守什么 |
| :--- | :--- | :--- | :--- |
| 1 | 类型检查 | `typecheck` | TS strict、`noUncheckedIndexedAccess`；`Ownership` 类型对新增字段做编译期穷尽检查 |
| 2 | 单元测试 | `test` | 纯函数全覆盖 |
| 3 | 零网络扫描 | `check:no-network` | 11 条规则，白名单为空 |
| 4 | 构建 | `build` | 单文件产物可生成 |
| 5 | 体积红线 | `check:bundle` | >490 KB 警告 / >540 KB 失败；单次涨幅 >20 KB 也拦 |
| 6 | 版本一致性 | `check:versions` | `package.json` / 扩展 `manifest.json` / 产物三处必须一致 |
| 7 | 社区内容 | `validate:community` | 格式 + 唯一性 + 长度 + 脱敏 |

**当前基线**（每条都能在 CI 里复现）：

| 指标 | 数值 |
| :--- | :--- |
| 单元测试 | 320 个 / 22 个文件，全绿（含灾难恢复 9 条） |
| 端到端冒烟 | 21 项，CDP 驱动真实 Edge，含导出 ZIP 的中央目录解析 |
| 性能基准 | `npm run bench`：50 / 200 / 500 / 1000 条实测；1000 条渲染 15 行，排序 21 ms，首屏 60–88 ms |
| 产物体积 | 491,558 B（480 KiB），红线 490 KB 警告 / 540 KB 失败 |
| 零网络扫描 | 通过，白名单为空 |
| 独立 QA | 478 断言 0 失败（[`docs/QA-REPORT-v0.2.md`](docs/QA-REPORT-v0.2.md)） |
| 可复现构建 | 干净目录 `npm ci && npm run build` 产物 sha256 一致 |

基准与冒烟都不跑 jsdom：它没有布局与合成层，最贵的操作（表格重排、滚动）量不出真实体感。冒烟脚本带自检 —— 数据没进界面（例如落进数据失败页）会直接判错，不输出一排漂亮的假数字。

<details>
<summary><b>🛠️ 开发与发布命令</b></summary>

```bash
cd app
npm install

npm run dev              # 开发模式
npm run typecheck        # tsc --noEmit
npm test                 # vitest
npm run build            # 类型检查 + 产出单文件 dist/index.html
npm run check:bundle     # 产物体积红线
npm run check:no-network # 静态扫描：不许出现网络调用
npm run check:versions   # 版本号三处一致性
npm run validate:community
npm run bench            # CDP 性能基准
node smoke-v05.mjs       # CDP 端到端冒烟

npm run verify           # 七关全套，交付前跑这一条
npm run release:pack     # 可复现的发布资产
```

发布前请走一遍 [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md)。

</details>

## 快捷键

| 键 | 作用 |
| :--- | :--- |
| `N` | 新建投递 |
| `1` – `5` | 今日 / 看板 / 列表 / 日历 / 复盘 |
| `⌘K` / `Ctrl+K` | 全局搜索（回车打开第一条） |
| `⌘Z` / `Ctrl+Z` | 撤销（可连按，最多 10 步） |
| `⇧⌘Z` / `Ctrl+Y` | 重做 |
| `Esc` | 关闭浮层 / 抽屉 |

## 已知限制

这一节不藏短板。下面每一条都是当前版本的真实边界，不是「未来会做」。

- **回收站只覆盖投递**：公司、面试、日程的删除仍走撤销栈，刷新后无法恢复
- **撤销栈是内存态**：刷新页面即清空。这是设计而非缺陷 —— 持久化撤销栈会带来「撤销到哪个版本」的歧义
- **列表窗口化影响全选**：超过 150 行时只渲染视口内的行，`Ctrl+A` 只能拿到已渲染的条目，所以「识别 N 条」小于总数是正常的
- **IndexedDB 是「有则优先」而非必需**：被禁用或处于私密模式时安静退回 localStorage，容量仍受 5 MB 限制
- **同步是文本解析，不是接口**：平台改版会让解析失效。失效时明确告诉你「没解析出来」，不会静默丢数据；BOSS / 实习僧 / 牛客的选择器尚未在真实登录页校准
- **裸姓名不脱敏**：面经导出能识别「面试官 / 老师 / 总」等称呼锚点，纯人名需要 NER，正则做不到
- **大库性能有上限**：1000 条可用（列表窗口化），但复盘、日历这类全量派生的视图仍随条数线性变慢，尚未分片
- **移动端只是能用**：窄屏做了响应式适配，拖拽与键盘快捷键是桌面优先设计的
- **剪贴板可能不可用**：`file://` 下部分浏览器禁止剪贴板 API，催进话术会自动展开在文本框里让你手抄
- **截止日期只有投递级**：没有「招聘季整体截止」，每条投递单独填
- **单文件体积有硬上限**：超 540 KB 会让 CI 失败 —— 刻意的约束，不是 bug

## 参与贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。加平台适配器从 [`docs/adapters/README.md`](docs/adapters/README.md) 开始；贡献面经看 [`community/SCHEMA.md`](community/SCHEMA.md) —— **脱敏是硬红线**。每个版本改了什么见 [`CHANGELOG.md`](CHANGELOG.md)。

提交前请跑 `npm run verify`，七道关卡全绿是合并的前提。安全问题是**不要开公开 Issue**，走 [`SECURITY.md`](SECURITY.md) 里的私下渠道。

## 许可

- 代码：MIT，见 [`LICENSE`](LICENSE)
- 社区面经内容（`community/`）：CC BY-SA 4.0，见 [`community/LICENSE`](community/LICENSE)

---

<div align="center">

如果它帮你拿到了 offer，一个 star 能让下一个找工作的人找到它。

<sub>Job Desk · MIT License</sub>

</div>
