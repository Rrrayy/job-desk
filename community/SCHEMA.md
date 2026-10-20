# 社区面经数据格式（v1）

`community/` 里的每个 `.json` 都是一份可以被求职工作台「面经 → 导入社区题库」直接吃进去的文件。
格式刻意做得**又松又严**：松在写法（很多字段可省），严在红线（脱敏、长度、id 唯一）。

机器校验：`cd app && npm run validate:community`。PR 必须跑过，CI 也会跑。

---

## 1. 文件形态

两种都接受（推荐第一种，方便以后加元信息）：

```json
{ "experiences": [ /* ... */ ] }
```

```json
[ /* ... */ ]
```

文件放在 `community/` 根下，命名建议 `<平台>-<公司>-<方向>-<年月>.json`，例如
`boss-bytedance-fe-intern-2025-03.json`。

## 2. 一篇面经（experience）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 全局唯一。小写字母/数字/短横线，6–60 字符，建议 `平台-公司-方向-年月` |
| `companyName` | string | ✅ | 公司名，≤ 40 字。用公开简称即可（`字节跳动`，不要写具体部门全称） |
| `jobTitle` | string | ➖ | 岗位名，≤ 40 字 |
| `round` | number \| null | ➖ | 第几轮，≥ 1 |
| `interviewDate` | string | ✅ | `YYYY-MM-DD`，必须是真实日期 |
| `result` | `passed` \| `failed` \| `pending` \| `unknown` | ➖ | 默认 `unknown` |
| `overallNote` | string | ➖ | 整场感受，≤ 2000 字 |
| `questions` | array | ➖ | 题目数组，见下 |

## 3. 一道题（question）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ➖ | 全局唯一（强烈建议写，重复导入时可去重） |
| `text` | string | ✅ | 题干，≤ 200 字。**写他能听懂的问题原话**，不要只写「算法题」 |
| `category` | `algo` \| `concept` \| `project` \| `behavior` \| `reverse` \| `hr` \| null | ➖ | 分类，决定「哪类题最容易挂」的统计 |
| `difficulty` | `1` \| `2` \| `3` | ➖ | 难度，默认 2 |
| `myAnswer` | string | ➖ | 我当时怎么答的，≤ 2000 字。**这是整份数据最值钱的部分**，没有它只是一份题目列表 |
| `nextTime` | string | ➖ | 下次怎么改，一句话 |
| `tags` | string[] | ➖ | 自定义标签 |

> 导入到应用里的题，`mastery` 一律是 `0`（不会），不会被当成本人的战绩；
> 面经会带「社区导入」角标，统计里单独区分。

## 4. 红线（不满足就别提交）

1. **脱敏**：不许出现手机号、邮箱、身份证号、QQ 号、微信号，以及 HR / 面试官的真实姓名。
   校验脚本会扫这些模式，命中直接失败。
   写法建议：把「HR 王女士」写成「HR」，把「内推人张三」写成「内推人」。
2. **长度**：公司名 ≤ 40、岗位名 ≤ 40、整场感受 ≤ 2000、题干 ≤ 200、我的回答 ≤ 2000。
   超了不是截断，是直接报错 —— 因为截断会悄悄吃掉信息。
3. **id 唯一**：跨文件也不能重复（同一家公司两场面试要用不同 id，通常用日期区分）。
4. **不许贴别人的原话当自己的**：`myAnswer` 写你自己的回答。抄一份标准答案进来，
   对你没价值，对别人是噪音。
5. **不许写公司内部信息**：不要写具体业务数据、内部系统名、未公开的招聘计划。

## 5. `_index.json`

社区目录必须有一份索引，用来给人浏览、也用来对账：

```json
{
  "version": 1,
  "updatedAt": "2025-03-12",
  "entries": [
    {
      "id": "boss-bytedance-douyin-fe-intern-2025-03",
      "file": "boss-bytedance-fe-intern-2025-03.json",
      "company": "字节跳动",
      "jobTitle": "抖音前端开发实习生",
      "round": 1,
      "interviewDate": "2025-03-04",
      "result": "failed",
      "questionCount": 7,
      "tags": ["前端", "一面"]
    }
  ]
}
```

规则：

- `entries[].id` 必须能在某个面经文件里找到；
- `entries[].file` 必须存在；
- 每个面经文件都必须出现在索引里（加了文件不更新索引 → 校验失败）；
- `questionCount` 必须等于该场面试的实际题数。

## 6. 加一篇面经的完整流程

```bash
# 1. 新建文件，按上面格式写
# 2. 更新 community/_index.json
# 3. 跑校验
cd app && npm run validate:community
# 4. 本地灌进去看一眼（可选）
cd app && npm run dev
#    复盘 → 面经 → 导入社区题库 → 选这个 json
```

校验通过 + 人工读过一遍脱敏，就可以提交 PR。
