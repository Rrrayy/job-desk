# 发布检查清单（Release Checklist）

> 这份清单是给**要 fork 出去自己发布**的人和**本仓库维护者**共用的。
> 顺序不能跳：第 1 条不做完，后面全部没有意义（别人 clone 到的是一个指向不存在仓库的地址）。

---

## 0. 先决定：你是「发布自己的版本」还是「发 PR 回上游」

| 你的目的 | 需要做的步骤 |
| --- | --- |
| fork 之后自己维护、自己发版 | 全部 1 → 9 |
| 只改代码、给上游提 PR | 只需 5（本地六关卡全绿）；**不要**动 `package.json` 里的仓库地址 |

---

## 1. 🔴 替换 `OWNER` 占位符（第一条，也是唯一会「看起来能跑但其实是错的」的一条）

仓库里的 `OWNER` 是刻意的占位符 —— 它让 CI 能过、让 `npm pack` 不报错，
但**指向的是不存在的地址**。发布前必须全量替换成你自己的 GitHub 用户名/组织名。

> ✅ **本仓库已完成**（2026-10-20，`Rrrayy/job-desk`）。本节保留是因为它对
> fork 发布的人同样成立 —— fork 之后从这一条开始走。

需要改的位置：

| 文件 | 字段 |
| --- | --- |
| `app/package.json` | `repository.url` → `git+https://github.com/<你>/job-desk.git` |
| `app/package.json` | `homepage` → `https://github.com/<你>/job-desk#readme` |
| `README.md` | 「30 秒上手」里的 `git clone <this-repo>` |
| `README.en.md` | 同上，`git clone <this-repo>` |
| `CONTRIBUTING.md`、`SECURITY.md`、`.github/ISSUE_TEMPLATE/*` | 任何 `github.com/OWNER/...` 链接 |

自查（应该一行都搜不到）：

```bash
# 仓库根目录执行
grep -rn "OWNER" --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" . \
  | grep -v node_modules
grep -rn "<this-repo>" --include="*.md" . | grep -v node_modules
```

> ⚠️ 注意：`docs/RELEASE-CHECKLIST.md`（本文件）里的 `OWNER` 是**说明的一部分**，
> 上面两条自查命令请对本文件加 `--exclude=RELEASE-CHECKLIST.md`，或人工忽略本文件的命中。

---

## 2. 版本号只在一个地方改

`app/package.json` 的 `version` 是唯一真源：

- 产物里不写版本号（单文件 HTML 没有 version 字段，避免两处不一致）；
- `CHANGELOG.md` 顶部补一节 `## [x.y.z] - YYYY-MM-DD`，写清「改了什么 / 为什么」；
- 语义化版本口径：
  - **MAJOR**：`app/src/types.ts` 的 schema 变更（需要新的迁移函数）；
  - **MINOR**：新增视图、新增适配器、新增导出格式；
  - **PATCH**：修 bug、改文案、改样式。

## 3. schema 变更 = 必须带迁移

只要动了 `app/src/types.ts` 的结构：

- [ ] `app/src/lib/migrate.ts` 里有 `migrateV<N>ToV<N+1>`，**纯函数、幂等、只加不减**
- [ ] 迁移前写回滚点（`jobdesk.v1.preMigrate.<ISO>`，保留 30 天）
- [ ] `app/src/lib/validateV2.ts` 放行新字段（否则下一轮启动会把自己刚写的库判为坏数据）
- [ ] 迁移失败时**不覆盖**用户的 `jobdesk.v1`，并把原文另存到 `jobdesk.v1.failedAt.<ISO>`
- [ ] 有对应的迁移单测（旧数据 → 新数据、空库、脏字段三种）

## 4. 六道关卡全绿

```bash
cd app
npm run verify
```

等价于依次执行：

| # | 命令 | 通过标准 |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` | 0 error |
| 2 | `npm test` | 全绿（含本轮新增的回归用例） |
| 3 | `npm run check:no-network` | 源码零网络调用 |
| 4 | `npm run build` | 产出 `app/dist/index.html` |
| 5 | `npm run check:bundle` | ≤ 470KB 提示 / ≤ 540KB 硬红线 |
| 6 | `npm run validate:community` | 社区面经格式 + 脱敏 + 唯一性 |

任何一条红，都不要发版。

## 5. 产物可用性手工确认（脚本测不出来的部分）

- [ ] 双击 `app/dist/index.html`（`file://` 协议）能正常打开 —— 这是最主要的用法
- [ ] 断网状态下打开，功能不受影响（本地优先）
- [ ] 导出一份 JSON、清空 localStorage、再导入，数据完整回来
- [ ] 用**旧版本**导出的 JSON 走一次导入 → 触发 v1→v2 迁移 → 数据不丢
- [ ] 手动把 `jobdesk.v1` 改成一段乱码 → 刷新 → 出现失败页，**且 `jobdesk.v1` 的字节数没有被改写**
- [ ] 窄屏（375px）无横向滚动条
- [ ] 版本号与 CHANGELOG 一致

## 6. 隐私与合规

- [ ] `community/` 里没有真实姓名、手机号、邮箱、公司内部代号
- [ ] 新增文案里没有「上传 / 同步到云端 / 登录」这类不存在的能力
- [ ] 扩展（`extension/`）权限没有扩大（只 `activeTab` + `scripting`）
- [ ] `docs/adapters/README.md` 的「已知限制」跟着平台改版更新

## 7. 打 tag 与发布

```bash
cd app
npm run release:prep     # 六关卡全绿 + 生成 release/v<版本>/ 发布资产
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

- [ ] 发布资产由 `npm run release:pack` 生成（`index.html` + 扩展 zip + `SHA256SUMS` + `manifest.json`），
      **不要手工替换文件** —— 手工替换会让 SHA256SUMS 和实际文件对不上
- [ ] 重复跑一次 `release:pack`，SHA256SUMS 不变（固定时间戳 + 固定顺序，哈希必须可复现）
- [ ] GitHub Release 附上 `release/v<版本>/` 下全部文件：`index.html` 双击即用（主要用法），
      扩展 zip 解压后走「加载已解压」
- [ ] Release 说明复用 `docs/RELEASE-NOTES-v<版本>.md`（内容与 CHANGELOG 对应小节保持一致）
- [ ] Release 说明里写明「数据只存在浏览器 localStorage，换浏览器/清缓存 = 数据没了，请导出备份」

## 8. 发布后 24 小时内

- [ ] 用干净浏览器（无缓存、无历史）实际走一遍「下载 → 打开 → 记一家 → 刷新」
- [ ] 看一眼 Issue 模板能不能正常创建
- [ ] 如果这次动了适配器：拿真实平台页面验证一次解析（页面改版会让它失效）

## 9. 小抄：不可动摇的产品红线

发版前最后自问一遍，这几条被破了就不是这个产品了：

1. **不联网**（除用户主动粘贴的平台文本外，不发起任何请求）
2. **不丢数据**：解析失败进暂存、迁移失败进失败页、覆盖前先留副本
3. **不假装**：做不到的事不写进文案；「已同步」≠「已替你操作平台」
4. **脱敏默认开**：导出的 Markdown 默认脱掉手机号/邮箱/薪资/面试官姓名
