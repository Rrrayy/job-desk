<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img src="assets/banner-light.svg" alt="求职工作台 Job Desk" width="100%">
</picture>

# 求职工作台 · Job Desk

**把投递当管线管 —— 今日待办 · 看板 · 沉默提醒 · 截止倒计时 · 面经复盘**

[![CI](https://img.shields.io/github/actions/workflow/status/Rrrayy/job-desk/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Rrrayy/job-desk/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-239%20passed-2ea44f?style=flat-square)
![bundle](https://img.shields.io/badge/bundle-449%20KB-4c6ef5?style=flat-square)
![network](https://img.shields.io/badge/network-0%20requests-2ea44f?style=flat-square)
![schema](https://img.shields.io/badge/schema-v2-845ef7?style=flat-square)
[![release](https://img.shields.io/github/v/release/Rrrayy/job-desk?style=flat-square)](https://github.com/Rrrayy/job-desk/releases/latest)
[![license](https://img.shields.io/github/license/Rrrayy/job-desk?style=flat-square)](LICENSE)
[![stars](https://img.shields.io/github/stars/Rrrayy/job-desk?style=flat-square)](https://github.com/Rrrayy/job-desk/stargazers)

[⬇️ 下载最新版](https://github.com/Rrrayy/job-desk/releases/latest) ｜ [English](README.en.md) ｜ [报告问题](https://github.com/Rrrayy/job-desk/issues) ｜ [更新日志](CHANGELOG.md)

<img src="assets/demo.gif" alt="动态演示：加载示例数据 → 今日待办 → 看板 → 日历时间冲突 → 详情抽屉一键催进" width="100%">
<sub>真实应用实录：示例数据 → 今日 → 看板 → 日历发现「面试撞组会」→ 详情页一键催进（顶栏「2 家已沉默」随之清零）。这 11 秒就是它的全部日常。</sub>

</div>

> **投了 50 家之后，你还记得哪家该催、哪家面试在今天、哪家已经沉默两周了吗？**
> 这就是它唯一想解决的问题。一家公司 = 一条线，一屏看清「现在做什么」。
> 它不是招聘聚合器，不做简历生成，也不搞自动化投递。

**适用场景**：日常实习、暑期实习、秋招、春招、提前批、校招、社招 —— 只要你在投简历，它的模型就成立。

---

## 目录

| 章节 | 你会看到 |
| :--- | :--- |
| [它能干什么](#-它能干什么) | 五个视图各回答什么问题 |
| [30 秒上手](#-30-秒上手) | 下载即用 / 源码构建 / 开发模式 |
| [界面一览](#-界面一览) | 11 秒动态演示 + 真实截图 |
| [设计取舍](#-设计取舍) | 六个「为什么这么设计」，含代价 |
| [数据存在哪](#-数据存在哪--怎么备份) | localStorage 全部 key + 备份边界 |
| [隐私与边界](#-隐私与边界) | 为什么一个请求都不发 |
| [架构](#-架构) | 技术栈、数据流、目录结构 |
| [工程质量](#-工程质量) | 七道 CI 关卡与当前基线 |
| [常见问题](#-常见问题) | 数据会不会丢、能不能上云、会不会封号 |
| [已知限制](#-已知限制) | 不藏短板 |

## ✨ 它能干什么

**五个视图，都在回答「现在做什么」**

| 视图 | 回答的问题 |
| :--- | :--- |
| 📋 **今日** | 今天有几场面试？谁该催了？哪家明天截止？ |
| 🗂️ **看板** | 50 家分别卡在哪个阶段（想投 → 已投 → 沟通中 → 面试中 → 结果） |
| 📃 **列表** | 按沉默天数排序，一眼看出「最凉的那几家」 |
| 📅 **日历** | 面试、课表、任何急事都标在同一天上 —— 具体几点撞没撞 |
| 📊 **复盘** | 漏斗转化、简历版本命中率、每周投递量；二级 tab 是**面经** |

**在视图之下，这些事它在替你做：**

- ⏱️ **沉默判定**：按渠道放大阈值（内推 ×3、官网 ×2），offer 阶段单独监控且不乘系数 —— 红了就是真该动了
- ⏰ **截止倒计时**：已过期 / 今天 / 3 天内三级紧急度，静音压得住「该催了」，**压不住外部期限**
- 💬 **催进话术**一键生成；3 秒记一家（公司 + 岗位就够），拖拽换阶段，`⌘Z` 可连撤 10 步、`⇧⌘Z` 重做
- 🧯 **崩了也不丢数据**：界面渲染出错时进「你的数据还在」兜底页，可一键下载原始 JSON，而不是白屏
- 🎤 **面试多轮次建模**：每轮一张卡片，带准备清单、形式、结果；挂了记在第几轮
- 📥 **课表导入**：从教务系统 / 课表 App 复制粘贴，一行一节课，识别不了的行告诉你原因；重复导入按替换处理，手动记的事不受影响
- ⚠️ **日程冲突检测**：面试 × 面试 × 课 × 任何急事，同一时间段精确重叠比对（分钟级），撞了谁、几点到几点直接告诉你
- 🔄 **平台状态同步**：BOSS / 实习僧 / 牛客的列表粘进来，自动比对差异、逐条确认、可撤销
- 📚 **面经**：一行一题快记 → 题库按「不会的先复习」排序 → 间隔复习 → 统计「哪类题最容易挂」
- 💾 JSON 备份 + CSV 投递表 + ICS 日历导出，schema 自动迁移（带回滚点，失败不上锁不覆盖）

## 🚀 30 秒上手

**方式一：直接下载（推荐）**

到 [Releases](https://github.com/Rrrayy/job-desk/releases/latest) 下载 **`index.html`** —— 就一个文件，
双击打开，`file://` 直接可用，不需要 Node、不需要起服务。

**方式二：从源码构建**

```bash
git clone https://github.com/Rrrayy/job-desk
cd job-desk/app
npm install && npm run build
# 双击 app/dist/index.html
```

**方式三：开发模式**

```bash
cd app && npm install && npm run dev   # http://localhost:5173
```

> 首次打开会让你选「加载示例数据看看」或「我要自己记第一家」。
> 示例是 8 家公司、7 种状态，30 秒能看懂这个产品在干什么。
> 看完了想清空：设置 → 数据 → **回到初始状态**（数据、设置、日程全清，欢迎页重现）。

### 可选：浏览器扩展

`extension/` 是一个零构建的 MV3 扩展，用来一键抓当前招聘页面的文本，省掉 `Ctrl+A / Ctrl+V`。
未上架商店，走「加载已解压的扩展程序」。扩展**不做解析**，只产出
`{format, url, title, capturedAt, text}` 信封，与粘贴通道走同一份解析代码 ——
所以解析器只需要维护一份。

## 📸 界面一览

顶部的 11 秒动态演示覆盖了「今日 → 看板 → 日历 → 详情」的完整闭环；下面是各视图的静态大图。

| 🗂️ 看板 —— 50 家卡在哪 | 📃 列表 —— 最凉的那几家 |
| :---: | :---: |
| ![看板](docs/screenshots-v0.3/02-board.png) | ![列表](docs/screenshots-v0.3/03-list.png) |
| **📅 日历 —— 这周撞不撞** | **📊 复盘 —— 漏斗与面经** |
| ![日历](docs/screenshots-v0.3/05-calendar.png) | ![复盘](docs/screenshots-v0.3/06-insights.png) |

**详情抽屉 —— 截止日、静音、沉默阈值都在这一屏**

![详情抽屉](docs/screenshots-v0.3/04-drawer.png)

## 🎯 设计取舍

这一节讲**为什么这么做**，以及每条选择的代价。功能列表哪都能看，取舍才是这个项目的样子。

### ① 截止与沉默是两条正交的轴

「对方多久没理我」和「外部世界给我的期限」是两件事，混在一起就会互相掩盖。

- **怎么做**：应用级 `deadlineAt` 用**三态语义** —— 未设置（继承）/ `null`（显式关闭）/ 日期（覆盖）。
  「已过期 / 今天 / 3 天内」三级紧急度，且**截止项不能一键划掉**，只能打开详情确认。
- **代价**：多一个字段、多一套校验。`??` 运算符在这里是陷阱（它把 `null` 和 `undefined` 合并成一支，
  而这两者含义正好相反），所以校验必须走 `asTriStateDate()`，不能图省事。

### ② 静音压得住软提醒，压不住硬截止

「今天不想被这个 App 催」是合理需求，但「明天网申截止」不该被算法藏起来。

- **怎么做**：静音落在「第 N 天 23:59:59」而不是 `now + N×24h`；
  在待办生成时，**截止计算排在静音判断之前** —— 顺序反了就是把人坑进去。
- **代价**：静音中的项目仍可能出现在今日待办里（如果它快截止了）。这是故意的，不是 bug。

### ③ 日历是一张通用日程表，不是「面试日历」

现实中撞车的从来不只是面试 —— 组会、体检、临时急事都会撞。

- **怎么做**：`db.events` 单表存所有日程（`kind` 区分课程与私事，`weekly` 按周几 / 单次按日期）。
  冲突检测把面试、课程、私事放进**同一个池子两两比对**，条件是「同一天 + `HH:mm` 区间精确重叠」
  （`a.start < b.end && b.start < a.end`），端点相接不算冲突。
- **代价**：课表导入是**替换语义**（只替换 `course && weekly`），必须保证手动记的事永不被覆盖 ——
  这条写在 `courseImport.ts` 的测试里，不是靠注释。

### ④ 撤销是栈，而且删除必须可撤销

单槽撤销等于没有撤销：手滑第二次就「没有可撤销的操作」。

- **怎么做**：10 步栈 + 重做；新操作清空重做栈；同步合并可撤不可重做（因为它的逆操作不是纯粹的逆）。
  撤销**按次快照**，绝不整库回滚 —— 否则会吞掉你之后手写的备注。
- **代价**：删除投递要额外记录被这条投递带走的行（面试 / 时间线 / 面经绑定），
  恢复时还要处理「面经已被改绑到别人身上」的情况 —— 这种情况**不抢回来**。

### ⑤ 出事的时候必须有出路

界面崩了、数据读不出来、写盘失败 —— 这几种情况下用户不能被困住。

- **怎么做**：`ErrorBoundary` 给三个出口（重新加载 / 下载原始 JSON / 复制错误信息）；
  读取失败时先把原文另存到 `failedAt.*` 再上锁，`saveDB` 直接 no-op。
- **代价**：**任何自动修复都被禁止**。自动修复会把「可恢复」变成「不可恢复」，
  所以这个页面只给出口，不猜、不修、不删。

### ⑥ 一个 HTML 文件，不是「懒得拆」

单文件、本地优先不是省事，是一系列**可验证的约束**：

| 约束 | 实现 | 防回归手段 |
| :--- | :--- | :--- |
| 零网络请求 | 无 fetch/XHR/beacon/WebSocket，无 CDN | CI 静态扫描 `check:no-network`（11 条规则），白名单为空 |
| 单文件双击可用 | `vite-plugin-singlefile` + `base:'./'`，JS/CSS 内联 | CI 产物检查 + `check:bundle` 体积红线 |
| 数据不出本机 | localStorage 单 key，导入导出走下载 | CI 扫描 + 代码评审红线 |
| 数据损坏不丢用户数据 | 读取失败即上锁，原文另存 `failedAt.*`（最多 3 份） | 三种损坏场景 × 刷新的硬验证（见 QA 报告） |
| 撤销不吞用户数据 | 按次快照（status / sync / delete 三类），纯函数回滚 | 单测覆盖 |
| 同步不骗沉默计时 | `touchedAt` 只用平台 `lastContactAt`；`lastActivityAt` 只走 `max()` | 同步引擎单测 31 条 |
| 迁移幂等可回滚 | 纯函数、只加不减、前置快照 | 迁移单测 11 条 + 迁移失败页 |

**代价**：体积有硬上限（540 KB FAIL），功能不能无限加。这是刻意的约束，不是 bug。

## 🔒 数据存在哪 / 怎么备份

| localStorage key | 内容 |
| :--- | :--- |
| `jobdesk.v1` | 全量数据：设置、公司、投递、面试、时间线、面经、题目、暂存区、日程 |
| `jobdesk.v1.ui` | 上次的视图位置（刷新后还原） |
| `jobdesk.v1.listFilters` | 列表视图的筛选条件（刷新后还原） |
| `jobdesk.v1.preMigrate.<时间>` | 迁移前的原始数据（回滚点，保留 30 天） |
| `jobdesk.v1.failedAt.<时间>` | 读取失败时的原始数据副本（最多 3 份，永不被覆盖修改） |

- 数据**只在这个浏览器里**：正常关闭、刷新、关机重启都在；清浏览器「网站数据」、无痕窗口、换浏览器 / 换设备会丢。
- **换电脑或清缓存前先导出**：设置 → 数据 → 「导出 JSON」，会下载 `求职工作台-备份-YYYY-MM-DD.json`。只有 JSON 能导入回来（CSV / ICS 是给别的软件看的）。
- 设置页会显示「上次备份：N 天前」，超 7 天标红。**提醒不阻止你做任何事**，只是不再让你凭记忆。
- 数据损坏 / 迁移失败时不会白屏也不会丢：应用进入只读锁定态，给你三个出口（下载原始数据、重试、用空数据进入），原始数据**不会被自动修改或删除**。

## 🛡️ 隐私与边界

这个项目最硬的一条承诺：**打开页面，浏览器不会为它发出任何请求。**

- 没有统计、没有埋点、没有第三方字体、没有 CDN、没有「检查更新」；
- `npm run check:no-network` 静态扫描 `app/src` 和 `extension/`（11 条规则，含 CSS `url()` / `@import` / `<link href>`），
  命中直接让 CI 失败；白名单默认**是空的** —— 空不是还没填，空就是真的一个都没有。

明确不做的事（不是排期问题，是产品定位）：

> ❌ 账号系统 / 云同步 ｜ ❌ 自动登录招聘平台、自动投递 ｜ ❌ 后台常驻、定时抓取 ｜ ❌ 把单文件产物拆成需要起服务的应用

<details>
<summary><b>🔄 招聘平台进度同步（点开看细节）</b></summary>

平台没有公开接口（就算有也不会给个人开发者用），所以这里做的不是「爬虫」，而是**「读你自己屏幕上已经能看到的内容」**：

```
① 抓取：整页 Ctrl+A/Ctrl+V，或用扩展（extension/）一键抓
② 预览：五类计数（新增 / 更新 / 无变化 / 冲突 / 待归类）+ 差异表
③ 确认：逐条勾选，冲突行默认不勾
④ 结果：写入了多少条、多少条进了暂存区
```

几条设计上的硬规矩（都写在 `docs/ARCHITECTURE-v0.2.md` 里，代码严格照做）：

- **只有第 ④ 步写库**。前三步返回上一步不产生任何副作用。
- 同步写入的时间线只用平台给的**最后联系时间**，绝不用「抓取时刻」—— 否则你每同步一次，沉默计时就被骗着清零一次。
- 「最后活动时间」永远走 `max()` 重算，不手工覆盖。
- 平台「邀请面试」只映射到「沟通中」+ 一条待办，**不会**自动给你排面试、**不会**自动造面试记录 —— 时间地点你没确认过，凭什么替你写。
- 没有变化的记录**不写时间线**（否则时间线会被同步噪音灌满）。
- 认不出、对不上的记录进**暂存区**，一条都不丢，逐条给阶段或忽略。
- 整个合并可**按次撤销**（逐字段回到合并前）。
- 五类计数守恒：新增 + 更新 + 无变化 + 冲突 + 待归类 === 识别条数。少一条就是 bug。

支持平台：BOSS 直聘、实习僧、牛客、通用表格兜底。平台改版了怎么办：见
[`docs/adapters/README.md`](docs/adapters/README.md)，每个适配器都有 fixture 和单测。

</details>

<details>
<summary><b>📚 面经与间隔复习（点开看细节）</b></summary>

入口在**复盘 → [面经]**（不新增一级 tab：面经是「面完当天才用」的低频功能）。

- **快记**：一行一题，`Enter` 连记，90 秒记 5 题。分类 / 难度 / 我的回答留到编辑器里补。
- **题库**：公司 / 分类 / 掌握度 / 到期 / 关键词 五维筛选，按「不会的先复习」排序。
- **复习卡**：`←` `→` 切题，空格翻面；标完掌握度自动重排下次复习时间（初始 +1/+3/+7 天，之后不会 +3、一般 +7、会了 +14）。
- **统计**：「哪类题最容易挂」（分母是**挂掉的场次数**，不是题目数）、公司高频题 Top 5、挂的原因分布。
- **导出**：一键 Markdown，可脱敏（公司名 → 首字母）。
- **社区题库**：`community/` 里是真人写的面经（CC BY-SA 4.0），**离线**导入 —— 你自己去 GitHub 下载 JSON，拖进设置页。产品不会替你发起拉取请求。

</details>

<details>
<summary><b>🧠 核心算法：沉默判定（点开看公式）</b></summary>

```
lastActivityAt = max(statusChangedAt, 该投递下所有 note.touchedAt)
silenceDays    = 今天（自然日零点）− lastActivityAt 的自然日差
```

- 阈值按渠道放大：内推 ×3、官网 ×2、其余 ×1；**单独设过阈值的公司不受系数影响**（填 10 就是 10 天）
- 沉默覆盖 `已投 / 沟通中 / 面试中 / 已发 Offer` 四个状态；面试中用「等结果超时」，offer 用独立的 `offerSilenceDays`
- **任何一条时间线新增、任何状态变更，`lastActivityAt` 立刻刷新，红色自动消失** —— 不需要手动「取消沉默」
- 撤销**只回滚那一次状态变更**：之后你手写的备注、面试、设置都不会被吞

</details>

## 🏗️ 架构

**技术栈**：Vite 5 + React 18 + TypeScript 5.6 strict。没有路由库、没有状态管理库、没有 UI 组件库。

- **状态中枢**在 `App.tsx`：所有写操作走 `mutate()`，内置撤销快照；`dbRef` 与 `db` 双轨（`ref` 给回调用，`state` 给渲染用）
- **视图层** 26 个组件，无 UI 库，样式是一份带 CSS 变量设计令牌的 `styles.css`
- **数据流**：`localStorage` → `validateV2` 校验 → `App.tsx` 持有 → 视图派生 → `mutate()` 写回
- **派生优先**：沉默天数、待办清单、漏斗统计全部由纯函数从 `DB` 算出，不落库。落库的派生值一定会和真实状态脱节

完整的数据模型、同步合并算法与所有权规则见 [`docs/ARCHITECTURE-v0.2.md`](docs/ARCHITECTURE-v0.2.md)。

<details>
<summary><b>📁 目录结构（点开）</b></summary>

```
job-desk/
├── app/                      # 应用本体
│   ├── dist/index.html       # 构建产物：单文件、双击即用
│   ├── src/
│   │   ├── App.tsx           # 状态中枢（所有写操作走 mutate()，含撤销快照）
│   │   ├── types.ts          # 数据模型（schema v2）
│   │   ├── adapters/         # 平台适配器：boss / shixiseng / nowcoder / custom（各带 fixture + 单测）
│   │   ├── lib/
│   │   │   ├── rules.ts      # 核心算法：沉默派生、截止判定、待办聚合、漏斗、话术、冲突检测
│   │   │   ├── courseImport.ts # 课表文本解析（一行一节课，坏行给原因）
│   │   │   ├── tableExport.ts# CSV / ICS 导出（防公式注入、RFC 5545 折行）
│   │   │   ├── storage.ts    # localStorage 读写 / 导入导出 / 校验 / 迁移入口 / 损坏上锁
│   │   │   ├── migrate.ts    # v1 → v2 迁移（纯函数、幂等、只加不减）
│   │   │   ├── rollback.ts   # 回滚点与 30 天清理
│   │   │   ├── interview.ts  # 面经统计与间隔复习
│   │   │   ├── sync/         # 同步引擎：normalize / statusMap / engine / capture
│   │   │   └── budget.ts     # 体积水位与文本截断
│   │   └── components/       # 视图 + 抽屉 + 面经 + 同步面板 + ErrorBoundary
│   └── scripts/              # 类型 / 测试 / 体积 / 零网络 / 版本一致性 / 打包脚本
├── assets/                   # README 横幅（SVG ×2）+ 动态演示 demo.gif
├── extension/                # 可选 MV3 扩展（只 activeTab + scripting）
├── community/                # 社区面经（CC BY-SA 4.0，离线导入）
├── docs/                     # PRD / 架构 / QA 报告 / 适配器指南 / 发布说明 / 截图
├── .github/                  # CI + Issue/PR 模板 + 网络白名单
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
└── CHANGELOG.md  LICENSE  README.en.md
```

</details>

## 🧪 工程质量

`npm run verify` 跑七道关卡，任何一道红就不许合并：

| # | 关卡 | 命令 | 守什么 |
| :--- | :--- | :--- | :--- |
| 1 | 类型检查 | `typecheck` | TS strict，`noUncheckedIndexedAccess`；`Ownership` 类型对新增字段做编译期穷尽检查 |
| 2 | 单元测试 | `test` | 纯函数全覆盖 |
| 3 | 零网络扫描 | `check:no-network` | 11 条规则，白名单为空 |
| 4 | 构建 | `build` | 单文件产物可生成 |
| 5 | 体积红线 | `check:bundle` | >470 KB 警告 / >540 KB 失败；单次涨幅 >20 KB 也拦 |
| 6 | 版本一致性 | `check:versions` | 主应用 `package.json` / 扩展 `manifest.json` / 产物三处必须一致 |
| 7 | 社区内容 | `validate:community` | 格式 + 唯一性 + 长度 + 脱敏 |

**当前基线（每条都能在 CI 里复现）：**

| 指标 | 数值 |
| :--- | :--- |
| 单元测试 | **239 个 / 16 个文件**，全绿（含灾难恢复 9 条） |
| 产物体积 | **460,142 B（449 KB）**（红线 470 KB 警告 / 540 KB 失败） |
| 零网络扫描 | 通过，白名单为空 |
| 独立 QA | 478 断言 0 失败（[`docs/QA-REPORT-v0.2.md`](docs/QA-REPORT-v0.2.md)） |
| 可复现构建 | 干净目录 `npm ci && npm run build` 产物 sha256 一致 |

<details>
<summary><b>🛠️ 开发与发布命令（点开）</b></summary>

```bash
cd app
npm install

npm run dev              # 开发模式
npm run typecheck        # tsc --noEmit
npm test                 # vitest
npm run build            # 类型检查 + 产出单文件 dist/index.html
npm run check:bundle     # 产物体积红线：>470KB 警告 / >540KB 失败
npm run check:no-network # 静态扫描：不许出现网络调用
npm run check:versions   # 版本号三处一致性
npm run validate:community

npm run verify           # 以上全套，交付前跑这一条
npm run release:pack     # 生成可复现的 Release 资产（index.html + 扩展 zip + SHA256SUMS + manifest）
```

发布前请走一遍 [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md)。

</details>

## ⌨️ 快捷键

| 键 | 作用 |
| :--- | :--- |
| `N` | ＋记一家 |
| `1` `2` `3` `4` `5` | 今日 / 看板 / 列表 / 日历 / 复盘 |
| `⌘K` / `Ctrl+K` | 全局搜索（回车打开第一条） |
| `⌘Z` / `Ctrl+Z` | 撤销（可连按，最多 10 步） |
| `⇧⌘Z` / `Ctrl+Y` | 重做 |
| `Esc` | 关闭浮层 / 抽屉 |

## ❓ 常见问题

<details>
<summary><b>数据会不会被清掉？</b></summary>

只要不清浏览器「网站数据」，就一直在 —— 正常关闭、刷新、关机重启都不影响。

会丢的情况只有三种：清了浏览器站点数据、在无痕窗口里用、换了浏览器或设备。
所以换电脑前请先「导出 JSON」。设置页会显示上次备份时间，超 7 天标红提醒。

</details>

<details>
<summary><b>为什么不做云同步 / 账号？</b></summary>

因为一旦有服务器，「一个请求都不发」就变成谎话，而这条承诺是这个产品存在的理由。

跨设备目前只有一条路：导出 JSON → 在另一台设备导入。这条路的缺点很明显（要手动），
但它没有隐私代价，也不会因为你没续费而删掉你的数据。

</details>

<details>
<summary><b>会不会被招聘平台判定为爬虫？</b></summary>

不会。它不登录、不自动点击、不发请求 —— 所有数据都来自你自己复制粘贴（或用扩展抓你自己屏幕上已经能看到的内容）。
从平台角度看，这就是「用户复制了一段文字」。

</details>

<details>
<summary><b>支持哪些平台？</b></summary>

BOSS 直聘、实习僧、牛客，以及「通用表格」兜底（任何能复制成表格的地方）。

适配器是纯函数（文本 → 结构化记录），每个都带 fixture 和单测。加平台 = 新增一个适配器文件 + fixture + 测试，
不需要改引擎。**注意**：BOSS / 实习僧 / 牛客的选择器尚未在真实登录页校准，解析失败会进「待归类」而不是写错库。

</details>

<details>
<summary><b>能在手机上用吗？</b></summary>

能打开、能看、能改，但拖拽和键盘快捷键是桌面优先设计的。窄屏做了响应式适配，
但它的主场是电脑 —— 投递这事本来就发生在电脑上。

</details>

<details>
<summary><b>投递上千条会卡吗？</b></summary>

当前 200 条量级流畅（今日待办计算 < 50 ms）。时间线索引已把今日待办从 `O(投递 × 时间线)` 降到 `O(投递 + 时间线)`，
但列表尚未做虚拟滚动，千条量级的滚动会开始掉帧 —— 这条写在下面的「已知限制」里，没有藏。

</details>

<details>
<summary><b>为什么 CSV 不能导入回来？</b></summary>

CSV 是有损的：它只有表格列，装不下面试轮次、时间线、面经、日程这些结构。
只有 JSON 是完整备份。CSV 和 ICS 的定位是「给别人 / 给别的软件看」。

</details>

<details>
<summary><b>可以商用吗？</b></summary>

代码 MIT，可以。`community/` 下的面经内容是 CC BY-SA 4.0，商用需遵守该协议（署名 + 相同方式共享）。

</details>

## ⚠️ 已知限制

- **没有回收站**：删投递是即时的（有二次确认 + 可撤销，但刷新页面后撤销栈就没了）—— 建议定期导出备份。
- **撤销栈是内存态**：刷新页面即清空，这是设计而非缺陷（持久化撤销栈会带来「撤销到哪个版本」的歧义）。
- **剪贴板可能不可用**：`file://` 下部分浏览器禁止剪贴板 API，催进话术会自动展开在文本框里让你手抄。
- **同步是文本解析，不是接口**：平台改版会让解析失效。失效时会明确告诉你「没解析出来」，不会静默丢数据。
- **列表虚拟滚动**：`Ctrl+A` 只能拿到已渲染的条目，所以「识别 N 条」小于总数是正常的。
- **移动端只是能用**：窄屏做了适配，但拖拽和键盘快捷键是桌面优先设计的。
- **单文件产物有体积上限**：超 540 KB 会让 CI 失败 —— 这是刻意的约束，不是 bug。
- **截止日期只有应用级**：没有「招聘季整体截止」，每条投递要单独填。
- **大库性能未实测**：200 条以上只做了算法级优化，端到端耗时尚无基准数据。
- **裸姓名不脱敏**：面经导出能识别「面试官 / 老师 / 总」等称呼锚点，但纯人名需要 NER，正则做不到。

## 🤝 参与贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。想加平台适配器，从
[`docs/adapters/README.md`](docs/adapters/README.md) 开始。想贡献面经，看
[`community/SCHEMA.md`](community/SCHEMA.md) —— **脱敏是硬红线**。
每个版本改了什么，看 [`CHANGELOG.md`](CHANGELOG.md)（含「为什么版本号从 1.0.0 回到 0.2.0」）。
发现安全问题请**不要开公开 Issue**，走 [`SECURITY.md`](SECURITY.md) 里的私下渠道。

**提交前请跑 `npm run verify`** —— 七道关卡全绿是合并的前提，不接受「本地能跑」。

## 📄 许可

- 代码：MIT，见 [`LICENSE`](LICENSE)
- 社区面经内容（`community/`）：CC BY-SA 4.0，见 [`community/LICENSE`](community/LICENSE)

---

<div align="center">

**如果它帮你拿到了 offer，欢迎给个 ⭐ 让更多找工作的人看到**

<sub>求职工作台 Job Desk · MIT License · Made for Chinese students hunting jobs</sub>

</div>
