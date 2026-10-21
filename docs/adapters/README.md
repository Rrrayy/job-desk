# 适配器文档

> 这份文档是**社区契约**。适配器协议的字段签名一旦改动就是 MAJOR 变更，
> 必须同步更新本文档与 `app/src/adapters/types.ts` 头部注释。

---

## 1. 适配器是什么，不是什么

「招聘平台的页面」和「我们的数据模型」之间隔着一道翻译。适配器只干这一件事：

```
一段文本  ──[ 适配器 ]──▶  一批规范记录 + 一批解析失败
(string)                   (NormalizedRecord[])  (UnparsedItem[])
```

**它明确不做的事**（三条边界，来自架构 D-02 / PRD §B.4）：

| 不做 | 为什么 |
| --- | --- |
| 不碰存储、不碰 React | 才能用 node 环境跑单测，不用起 jsdom。适配器是纯函数，`import` 链里不许出现 `storage` / `react`。 |
| 不解释产品语义 | 「邀请面试」算 `chatting` 还是 `scheduled`，是**产品决策**，集中在 `lib/sync/statusMap.ts`。适配器只负责把原文原样放进 `platformStatusText`。 |
| 不发请求、不读系统时间 | 时间由调用方注入（`ParseContext.now` / `AdapterInput.capturedAt`）。同输入必然同输出，测试才能稳定。 |

一句话：**适配器是「认识页面」的人，不是「理解产品」的人。**

---

## 2. 现有适配器

| id | 名称 | `urlPattern` | 输入 | `lastVerifiedAt` | 状态 |
| --- | --- | --- | --- | --- | --- |
| `boss` | BOSS 直聘 | `zhipin.com/web/geek/chat` | paste | 2026-10-21 | 稳定（求职记录页真机校准） |
| `shixiseng` | 实习僧 | `shixiseng.com/my/delivery` | paste | 2026-10-21 | 详情页真机校准；列表页未验证 |
| `nowcoder` | 牛客 | `nowcoder.com/my/applications` | paste | 2026-10-21 | 详情页真机校准；列表页未验证 |
| `liepin` | 猎聘 | `liepin.com` | paste | 2026-10-21 | 详情页真机校准；列表页未验证 |
| `custom` | 通用表格 / 其他平台 | 任意页面的列表 / 表格 | paste | 2025-03-01 | 兜底 |

**详情页通道**（2026-10-21 新增）：用户从手机 App 整页复制单个职位详情时，
`parseDetailLike` 产出**恰好一条**记录；详情页没有状态行与联系事件，
`status` / `lastContactAt` 一律留空（绝不拿「截止时间」「90天前更新」凑数）。

- **顺序即优先级**：`registry.ts` 里 `ADAPTERS` 的数组顺序 = 下拉框顺序 = URL 命中优先级。
  `custom` 永远排最后，因为它 `matchUrl` 恒 `false`（只能被手动选中）。
- **`lastVerifiedAt` 超过 6 个月**，UI 会标「⚠️ 可能已失效」。**标但不阻断** ——
  「可能失效」不等于「一定失效」，用户手里还有预览那一步可以兜底，不该因为我们懒就挡住他。
- 目前所有适配器 `inputType` 都是 `paste`。`'dom'` 是预留值，还没人用
  （浏览器的 DOM 结构来自扩展，扩展只提供**纯文本**，见第 8 节）。

---

## 3. 协议

完整类型见 `app/src/adapters/types.ts`。这里只讲**为什么这么设计**。

### 3.1 输入：只有字符串

```ts
interface AdapterInput {
  url?: string;
  title?: string;
  text: string;      // 唯一必填
  html?: string;     // 预留，当前无人提供
  capturedAt: string;
}
```

页面结构会变、CSS class 会重命名、SPA 会改 hydration 方式 —— 但**用户复制出来的文本形态相对稳定**。
只吃字符串，意味着：

- 适配器不依赖 DOM，测试只要一个 `.txt` fixture；
- 用户可以在任意浏览器、任意设备上「手动复制 → 粘贴」，不装扩展也能用；
- 我们永远不需要往页面里注入代码去读 DOM（那就是「自动抓取」了，越界）。

`html` 字段留着，是为了**将来**如果真要做 DOM 适配器时不用改协议（加字段是 MINOR）。

### 3.2 输出：记录 + 失败，缺一不可

```ts
interface AdapterResult {
  records: NormalizedRecord[];
  unparsed: UnparsedItem[];   // { rawSnippet, reason }
}
```

**`unparsed` 不是可选的礼貌，是 P0 要求。** 解析不了的行必须留在这里，
带一句人话原因（「这一行没有公司名」「日期格式不认识」），在预览页折开展示。

绝对禁止的两种做法：

- ❌ **静默丢**：用户以为同步成功了，其实少了 6 条。
- ❌ **编一个**：拿上一行的公司名凑数、拿「未知公司」占位。
  一条脏数据会污染去重、污染统计，比少一条严重得多。

### 3.3 `confidence`：逐字段 + 整条

```ts
type Confidence = 'high' | 'medium' | 'low';
confidence: Partial<Record<keyof NormalizedRecord, Confidence>>;  // 缺省 = medium
overall: Confidence;  // = 各字段最小值（overallOf()）
```

置信度**不改变解析结果**，只改变 UI 的呈现与用户的警惕程度：

- `high` → 默认勾选，正常显示
- `medium` → 默认勾选，但预览里标灰底
- `low` → 默认**不勾选**，需要用户主动确认

宁可标 low 让用户多看一眼，也不要 high 得很自信然后写错。

### 3.4 时间：`lastContactAt` 不许用抓取时刻顶替

这是**最容易犯、后果最严重**的错误。

```ts
lastContactAt?: string;  // ISO。拿不到就是 undefined
```

如果用 `capturedAt` 兜底，用户一点同步，20 条沉寂半个月的记录全部变成「今天有活动」，
沉默红点集体消失，整个产品的核心价值（「哪家该催了」）当场失效。

正确做法：拿不到业务时间就 `undefined`。引擎会因此**不写 note**（`touchedAt` 无从谈起），
只刷心跳 `sync.lastSyncedAt`。用户在预览页看得见「这条没有平台时间」，可以选择手动记一条。

### 3.5 `externalId`：有就用，没有别编

平台自己的 ID（BOSS 的 encryptJobId、牛客的 applyId）是最强的匹配锚点。
拿不到就留空 —— **不要**用「公司名 + 岗位名」的哈希假装是 ID，那会让去重第 2 级和第 1 级互相污染。

---

## 4. 从文本到写入：引擎做了什么

适配器交出的 `NormalizedRecord[]` 会被 `lib/sync/engine.ts` 的 `plan()` 处理。
理解这一段，才知道适配器该把什么填准。

### 4.1 归一化（`lib/sync/normalize.ts`）

| 函数 | 做什么 |
| --- | --- |
| `toHalfWidth` | 全角字母数字 → 半角（`ＢＯＳＳ` → `BOSS`） |
| `normalizeCompanyName` | 去括号后缀、去「有限公司/股份有限公司」、去空白、小写 |
| `normalizeJobTitle` | 去「（实习）」「-2025」等修饰、去空白、小写 |
| `buildMatchKey` | `` `${company}\|${title}` ``，存进 `app.sync.matchKey` |
| `diceCoefficient` | 双字组 Dice 相似度，用于模糊匹配 |

`NORMALIZE_VERSION` 参与匹配：本地 `app.sync.matchKeyVersion !== NORMALIZE_VERSION` 的老库
不会走第 2 级匹配（否则归一化算法一改，历史 matchKey 会错配）。**改归一化逻辑必须升这个版本号。**

### 4.2 五级去重（顺序敏感，先命中者胜）

| 级 | 依据 | `matchedBy` | 说明 |
| --- | --- | --- | --- |
| 1 | `sync.externalId` + 同平台 | `externalId` | 最可信。平台换了 ID 就会退化到第 2 级。 |
| 2 | `sync.matchKey`（归一化公司 + 岗位） | `matchKey` | 要求 `matchKeyVersion` 一致。 |
| 3 | 公司 + 岗位**模糊**（Dice ≥ `TITLE_SIMILARITY = 0.8`） | `company+title` | 只在**唯一命中**时采用；多条候选 → 暂存。 |
| 4 | 公司 + **空岗位** | `company+emptyTitle` | 用户建了「公司占位」时命中。同样要求唯一。 |
| 5 | 都没命中 | — | 新建投递（并可能新建公司）。 |

**一条重要设计**：第 3 / 4 级如果命中**多条**，不进「新建」也不猜，直接落进**暂存区**
（`kind: 'staged'`，`stagedReason: 'ambiguous'`），列出候选让用户指定。
「猜错了」的代价远高于「多问一句」。

同一批粘贴里出现两条完全相同的「公司 + 岗位」也会进暂存 —— 那是用户复制了两遍，不是两家公司。

### 4.3 五类计数（预览页顶部的五个数字）

| kind | 含义 | 用户看到什么 |
| --- | --- | --- |
| `new` | 库里没有 → 新建投递 | 列出将新建的条数 |
| `update` | 命中已有，且至少一个字段要改 | 逐字段 diff（旧值 → 新值） |
| `unchanged` | 命中已有，但所有字段都一样 | 灰显，唯一动作是刷心跳，**不写 note** |
| `conflict` | 命中已有，但要改的字段被用户手改过 / 平台时间更旧 / 推进次序冲突 | 强制逐条确认，默认不勾 |
| `staged` | 归类不了（状态不认识 / 多条候选 / 缺公司名） | 进「待归类」清单，不写库 |

不变式：`rows.length === records.length`，`new + update + unchanged + conflict + staged === records.length`。
`plan()` 末尾会主动校验这条，违反直接抛错 —— 宁可白屏报错，也不要悄悄少写一条。

### 4.4 字段归属（`lib/sync/ownership.ts`）

七种归属，编译期穷尽检查（`Record<keyof Application, Ownership>`）：

| 归属 | 含义 | 典型字段 |
| --- | --- | --- |
| `never` | 平台不写，用户也不直接写（写入器维护） | `id` / `companyId` / `createdAt` / `updatedAt` |
| `platform-only` | 平台独占，用户不可见 | `sync` |
| `user-only` | 永远以用户为准，平台永不触碰 | `jobType` / `priority` / `tags` / `resumeVersion` / `silenceOverride` / `rejectReason` |
| `fill-only` | 平台可写，**仅当本地为空** | `jobTitle` / `jdUrl` / `city` / `salaryText` / `appliedAt` |
| `platform-later-only` | 平台可写，但仅当平台时间晚于本地 | `lastActivityAt` |
| `platform-guarded` | 四重约束（映射命中 + 置信度 + 未手改 + 推进次序） | `status` / `statusChangedAt` |
| `set-once` | 只在本地为空时按平台设一次 | `channel` |

**给适配器作者的推论**：把「用户主观判断」类字段（岗位类型、优先级、标签）填了也没用，
引擎根本不会写。除非这个字段是「用户自己判断的」，你只填事实。

### 4.5 三条同步硬规矩（实现细节，改之前先看 PR 模板的自查表）

1. 同步写的 note，`touchedAt` **只用** `record.lastContactAt`。取不到 → 不写 note。
2. `lastActivityAt` 走 `max()` 重算（`lastActivityAtOf`），**不走** `App.addNote` 的副作用。
3. 无变化的记录**不写 note**，只刷 `sync.lastSyncedAt` 心跳。

所以：**同一条同步跑两次，第二次必然全部落进「无变化」，note 数量一条不增。**
这是回归测试里最重要的一条断言（`engine.test.ts`）。

---

## 5. 新增一个适配器

以「拉勾」为例，完整七步。

### 第 1 步：建目录

```
app/src/adapters/lagou/
├── adapter.ts        # 元信息 + SyncAdapter 对象
├── parse.ts          # 纯函数解析（真正干活的地方）
├── parse.test.ts     # 至少 3 条：正常 / 空输入 / 垃圾输入
└── fixtures/
    ├── list.txt      # 正常列表（脱敏）
    ├── empty.txt     # 空文件
    └── garbage.txt   # 一堆乱码
```

### 第 2 步：写 `parse.ts`

```ts
import type { AdapterInput, AdapterResult, ParseContext, NormalizedRecord } from '../types';
import { parseListLike } from '../shared';

export function parseLagou(raw: AdapterInput, ctx: ParseContext): AdapterResult {
  // 90% 的情况到这里就够了：通用管线已经处理了切块、公司名、状态、时间、薪资
  return parseListLike(raw.text, ctx.now);
}
```

要覆盖通用管线的字段判断时，传 `options`（见 `shared.ts` 的 `GenericOptions`），
而不是复制一份 `parseListLike`。只有在**整页结构完全不同**（例如表格页）时，才手写逐行逻辑 ——
届时把解析不了的行按下面这样兜住：

```ts
const records: NormalizedRecord[] = [];
const unparsed: AdapterResult['unparsed'] = [];
for (const line of raw.text.split('\n')) {
  const companyName = pickCompany(line);
  if (!companyName) {
    unparsed.push({ rawSnippet: line.slice(0, 500), reason: '这一行没有公司名' });
    continue;
  }
  records.push({ companyName, confidence: { companyName: 'high' }, overall: 'high' });
}
return { records, unparsed };
```

`shared.ts` 里已经有（**先用它们，别复制**）：

| 函数 | 用途 |
| --- | --- |
| `splitLines(text)` | 统一换行、去空行、去纯装饰行 |
| `looksLikeStatus` / `looksLikeSalary` / `looksLikeCity` / `looksLikeCompany` / `looksLikeJobTitle` | 单行分类启发式 |
| `extractTime(line, nowIso)` / `parsePlatformTime(token, nowIso)` | 日期文字 → `DateHit`（含「今天/昨天/前天」与月日无年份的补年） |
| `isTimeOnlyLine(line, nowIso)` | 这一行除了时间什么都没有 |
| `stripDecorations(line)` | 去 emoji、分隔符、序号前缀 |
| `clampSnippet(text, n = 500)` | 截断到 500 字（`unparsed.rawSnippet` 的上限） |
| `chunkByBlankLines` / `chunkByTrailingTime` | 把整页文本切成「一条记录」的两个基本策略 |
| `parseListLike(text, nowIso, options?)` | **通用列表管线**：切块 → 逐块抽字段 → 组装记录。新适配器通常只需要配置它。 |

### 第 3 步：写 `adapter.ts`

```ts
import type { SyncAdapter } from '../types';
import { parseLagou } from './parse';

export const lagouAdapter: SyncAdapter = {
  id: 'lagou',
  name: '拉勾',
  platform: 'lagou',
  version: '1.0.0',
  lastVerifiedAt: '2025-03-12',       // 你**真的**看过页面的日期
  urlPattern: 'lagou.com/jobs/collections',
  matchUrl: (url) => /lagou\.com\/(jobs|my)/.test(url),
  inputType: 'paste',
  parse: parseLagou,
};
```

`PlatformId` 是联合类型，在 `app/src/types.ts` 里加 `'lagou'`；
`PLATFORM_LABEL` 也要加一行（`registry.ts`），否则 UI 显示 `undefined`。

### 第 4 步：写测试

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLagou } from './parse';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const CTX = { now: '2025-03-12T10:00:00+08:00' };

describe('拉勾适配器', () => {
  it('正常列表全部解析出来', () => {
    const out = parseLagou({ text: fixture('list.txt'), capturedAt: CTX.now }, CTX);
    expect(out.records.length).toBeGreaterThan(0);
    expect(out.records[0].companyName).toBeTruthy();
    expect(out.unparsed).toHaveLength(0);
  });

  it('空输入不崩、不编造', () => {
    const out = parseLagou({ text: '', capturedAt: CTX.now }, CTX);
    expect(out.records).toEqual([]);
  });

  it('垃圾输入全部进 unparsed，不静默丢', () => {
    const text = fixture('garbage.txt');
    const out = parseLagou({ text, capturedAt: CTX.now }, CTX);
    expect(out.records.length + out.unparsed.length).toBeGreaterThan(0);
  });

  it('不使用抓取时刻冒充 lastContactAt', () => {
    const out = parseLagou({ text: '某公司 前端实习\n', capturedAt: '2025-03-12T10:00:00+08:00' }, CTX);
    out.records.forEach((r) => {
      if (r.lastContactAt) expect(r.lastContactAt).not.toBe('2025-03-12T10:00:00+08:00');
    });
  });
});
```

第 4 条测试是**红线测试**，请务必写 —— 它是唯一能自动拦住「拿 capturedAt 顶替」的闸门。

### 第 5 步：注册

```ts
// registry.ts
import { lagouAdapter } from './lagou/adapter';
export const ADAPTERS: SyncAdapter[] = [bossAdapter, shixisengAdapter, nowcoderAdapter, lagouAdapter, customAdapter];
//                                                                        ↑ custom 永远最后
```

`registry.test.ts` 补一条：`expect(adapterForUrl('https://www.lagou.com/jobs/collections')?.id).toBe('lagou')`。

### 第 6 步：脱敏 fixture

保留：公司名、岗位名、城市、薪资区间、平台状态文案、相对日期。
替换：人名 → `HR`、手机号 → `138****0000`、邮箱 → `hr@example.com`、
微信号 / QQ / 内推码 → 删除整行。

用真事结构，不用真事隐私。

### 第 7 步：跑闸门

```bash
cd app
npx tsc --noEmit
npm test
npm run check:no-network     # 适配器里绝对不能出现 fetch
npm run build && npm run check:bundle
```

PR 模板里勾「新增适配器」并逐条对照那 6 项清单。

---

## 6. 页面结构变了怎么办

这是**必然发生**的事，不是意外。

1. **先别改代码，先抓证据**：用户能否稳定复制出一段文本？如果连文本都变了，问题在平台改版，
   不在我们的解析。
2. **加 fixture**：把新形态的脱敏文本放成 `fixtures/list-new.txt`，测试里同时断言新旧两种。
   老形态往往还有人在用（有的人还没更新页面缓存）。
3. **优先放宽启发式，不要写死文本**：`looksLikeCompany` 里的收尾词表加一个词，
   比新增一条 `if (line === '某某科技有限公司')` 稳得多。
4. **更新 `lastVerifiedAt`** —— 这是唯一一个「如实记录」的字段，别为了消掉 ⚠️ 而乱改。
5. **如果实在解析不了**：把该平台适配器的 `matchUrl` 改成只匹配你确认过的 URL 前缀，
   让未匹配的页面自然落到 `custom`（通用表格），用户至少还能用。

---

## 7. 已知限制

| 限制 | 影响的场景 | 我们的取舍 |
| --- | --- | --- |
| 只吃纯文本 | 极少数把状态做成图标的页面（图标无 alt）读不出状态 | 状态为 `undefined` → 落「待归类」，用户手选。不猜。 |
| 不识别发信方 | 「沟通中」分不清是对方发起还是我发起 | 统一按高置信度 `chatting`（架构 §8-歧义 3）。真要区分只能读 DOM，越界。 |
| 日期只有相对时间 | 「昨天」在跨时区 / 跨零点时可能差一天 | 用本地时区按注入的 `now` 折算；跨零点误差接受。宁可差一天，不猜绝对日期。 |
| 不处理分页 | 用户只复制了第一页 | UI 明确写「只解析你粘贴的这一页」；想要全量就多粘几次，去重会合并。 |
| 一页多平台混合 | 用户把 BOSS 和牛客的文本粘在一起 | 用选中平台解析，解析不出的落 `unparsed`（有原因），不静默吞。 |
| 单次上限 200 条 | 粘了 500 条 | 超出的进 `STAGING_LIMIT` 之外的部分会被提示分批。一次改 200 条已经超出人能 review 的极限。 |
| 不认领「内推」 | 平台不标渠道 | `channel` 是 `set-once`：本地为空时按平台填（多数是「平台」），用户可手改一次后我们不再动。 |

---

## 8. 为什么扩展里有两份选择器

`extension/selectors.json` 和 `extension/content.js` 里的 `SELECTORS` 常量**内容重复**。
这不是疏忽：

- MV3 的内容脚本里 `fetch('../selectors.json')` 会**发出网络请求**（哪怕是 `file://` 或扩展内部协议），
  而我们的 `check:no-network`（以及我们对用户的承诺）是「零网络」。
- `chrome.runtime.getURL` + `fetch` 同样要走 `fetch`，一样会被扫描拦下。
- 内容脚本是**注入到页面上下文**执行的，没有模块打包，`import` 用不了。

所以：**同源两份，改动必须同时改。** `selectors.json` 是给人读的（也方便未来做「选择器热修」），
`content.js` 那份是运行时真正用的。两份都带 `version` 字段（`2025-03-01`），不一致时以 `content.js` 为准。

内容脚本的职责边界：**只把 DOM 变成纯文本**，不做任何解析。解析是适配器的事 ——
这样「页面结构变了」只影响选择器，「解析规则变了」只影响 `parse.ts`，两件事不会纠缠。

---

## 9. 变更这份协议

| 改动 | 版本 | 要做的事 |
| --- | --- | --- |
| 新增可选字段（如 `jdUrl` 之外再加 `salaryUnit`） | MINOR | 适配器可选择性填；本文档加一行；老适配器不用改。 |
| 改现有字段语义（如 `lastContactAt` 从 ISO 改成时间戳） | **MAJOR** | 全部适配器 + 引擎 + 测试同步改；`SCHEMA`/CHANGELOG 写清；给老库写迁移。 |
| 删字段 | **MAJOR** | 同上，且要考虑「已有数据里这个字段怎么办」。 |
| 改 `inputType` 枚举（加 `'dom'`） | MINOR（加） / MAJOR（删） | 加 `'dom'` 时引擎要能处理 `html` 为空的情况。 |

改完协议，请顺手检查这三处是否一致：

1. `app/src/adapters/types.ts`（唯一真源）
2. 本文档
3. `.github/pull_request_template.md` 的适配器清单

---

## 10. 相关文件索引

| 文件 | 作用 |
| --- | --- |
| `app/src/adapters/types.ts` | 协议定义（改这个 = 改契约） |
| `app/src/adapters/registry.ts` | 注册表 + URL 命中 + 平台中文名 |
| `app/src/adapters/shared.ts` | 共用行启发式（新增适配器先用这里） |
| `app/src/lib/sync/normalize.ts` | 归一化 + Dice 相似度 + matchKey |
| `app/src/lib/sync/statusMap.ts` | 平台文案 → 内部状态（产品语义，**不在适配器里**） |
| `app/src/lib/sync/ownership.ts` | 字段归属表（同步引擎的宪法） |
| `app/src/lib/sync/engine.ts` | `plan()` 去重与差异、`apply()` 写入、`revertSync()` 撤销 |
| `app/src/lib/sync/capture.ts` | 三通道统一：JSON 信封 / 纯文本 / 文件 |
| `extension/selectors.json` | 扩展的 DOM 选择器（人读版） |
| `extension/content.js` | 扩展的 DOM → 纯文本（运行时版） |
