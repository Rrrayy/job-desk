# AI 与插件权限边界（v0.8）

> 从 v0.8 起，产品第一次让「外部智能」进来。这份文档把边界写在代码之外，
> 供使用者与后续开发者核对。约束本身由测试守着（见 `app/src/ai/*.test.ts`、
> `app/src/plugins/*.test.ts`、`app/scripts/smoke-plugin.mjs`）。

这一版第一次让「外部智能」进入这个产品，所以边界要写在文档里，而不只是写在代码注释里：

| 主体 | 可以 | 不可以 |
| --- | --- | --- |
| 内置 AI 场景（D14/D15/D17） | 读**用户勾选**的字段；产出 `AISuggestion` | 直接写 `applications` / `questions` / `notes`（必须经用户确认 + `acceptSuggestions`）；读未勾选的库内字段 |
| D17 | 写 `staging.parsed`（缓冲表） | 碰 `applications`；发送原文之外的任何内容 |
| 插件 | 经宿主 RPC 申请：读投递（已授权时）/ 提交建议 / 用自己的存储 / 请求 AI（过 D13） | 自己 `fetch`（CSP 拦截）；跨 pluginId 读写；绕过预览；写核心表 |
| 任何自动化 | — | 自动合并、自动修复、自动改用户数据（PRD §7 明确不做） |
| 网络 | 只有 `app/src/ai/gateway.ts` 一处 `fetch`，且只在用户确认发送后 | 打开页面时任何请求；上报；检查更新；远程字体/图标 |

`check-no-network` 11 条规则照扫，`no-network-allowlist` 保持为空；
gateway.ts 的 `fetch` 是**结构性单点放行**（只豁免这一条规则，另有专项审计）。
