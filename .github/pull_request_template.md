# 改动说明

## 这个 PR 做了什么

<!-- 一两句话。修 bug 写清「什么现象」，加功能写清「解决谁的什么问题」 -->

## 类型

- [ ] 修 bug
- [ ] 新功能
- [ ] 重构（行为不变）
- [ ] 文档 / 注释
- [ ] 社区面经数据（`community/`）

## 关键检查（本地跑过再提）

- [ ] `cd app && npx tsc --noEmit` 通过
- [ ] `cd app && npm test` 通过
- [ ] `cd app && npm run check:no-network` 通过（**没有新增任何网络调用**）
- [ ] `cd app && npm run build` 成功
- [ ] `cd app && npm run check:bundle` 没有破 600KB 红线
- [ ] `cd app && npm run validate:community` 通过（改了 `community/` 才需要）

> 其实只要 `cd app && npm run verify` 一条命令就能全跑完。

## 语义红线自查（任何一条被改动，都必须在下面写清楚）

- [ ] 同步 note 的 `touchedAt` **只用**平台给的 `lastContactAt`，没有用「抓取时刻」
- [ ] `lastActivityAt` 仍然走 `max()` 重算，没有绕过 `rules.ts` 的 `lastActivityAtOf`
- [ ] 没有变化的那次同步**不写 note**
- [ ] 平台「邀请面试」仍然只映射到 `chatting` + 一条待办，**没有**自动进 `scheduled`、**没有**自动造 Interview
- [ ] schema 迁移 `migrateV1ToV2` 仍然幂等、无损、只加不减
- [ ] localStorage key 仍然是 `jobdesk.v1`
- [ ] 产物仍然是单个 `app/dist/index.html`

## 是否新增适配器

- [ ] **本 PR 新增了招聘平台适配器**

如果是，请逐项确认：

- [ ] 适配器放在 `app/src/adapters/<platform>/`，导出 `adapter.ts` + `parse.ts`
- [ ] 在 `app/src/adapters/registry.ts` 里注册（含 `hosts` / `matchKeyVersion` / `fixturePath`）
- [ ] 有一份**脱敏过**的 fixture（`fixtures/*.txt`）和对应的 `expected.json`
- [ ] 有 `parse.test.ts`，覆盖：正常列表、空页、乱码/非列表页三种输入
- [ ] `docs/adapters/<platform>.md` 写清「抓哪一页、拿不到哪些字段、已知限制」
- [ ] 没有为了让测试通过而放宽其它适配器的启发式规则

## 截图 / 录屏（界面改动必填）

<!-- 拖进来就行。窄屏（<900px）也顺手截一张，样式最容易在这里翻车 -->

## 有没有「暂时先这样」的地方

<!-- 有就写，别藏。写出来至少下一个人不会踩。没有就写「无」 -->
