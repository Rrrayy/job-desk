/**
 * 社区面经校验。
 *
 * `community/` 是这个仓库唯一接受外部贡献的数据目录，也是最容易出事的地方：
 * 一条带着 HR 手机号的面经推上去，删掉 commit 也没用了。所以这里把「格式」和
 * 「脱敏」都变成机器检查，PR 里不用靠人肉 review 记这些规则。
 *
 * 检查项（任一失败即 exit 1）：
 *   1. 结构：`_index.json` 与每个 `*.json` 的字段类型 / 枚举值
 *   2. 唯一：experience.id、question.id 全局唯一
 *   3. 长度：公司名 ≤ 40、整场感受 ≤ 2000、题干 ≤ 200、我的回答 ≤ 2000
 *   4. 脱敏：不许出现手机号 / 邮箱 / 身份证 / QQ 号 / 微信号 / 真实姓名占位
 *   5. 一致：`_index.json` 必须列全所有文件，且 questionCount 与实际题数一致
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const communityDir = resolve(repoRoot, 'community');

const CATEGORIES = new Set(['algo', 'concept', 'project', 'behavior', 'reverse', 'hr']);
const RESULTS = new Set(['passed', 'failed', 'pending', 'unknown']);

const LIMITS = {
  companyName: 40,
  jobTitle: 40,
  overallNote: 2000,
  questionText: 200,
  myAnswer: 2000,
};

/** 脱敏规则：命中即失败（这些内容一旦公开就没法收回） */
const SENSITIVE = [
  { id: 'mobile', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/, why: '手机号' },
  { id: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/, why: '邮箱' },
  { id: 'idcard', regex: /(?<!\d)\d{17}[\dXx](?!\d)/, why: '身份证号' },
  { id: 'qq', regex: /(?:QQ|qq)\s*[:：]?\s*\d{5,11}/, why: 'QQ 号' },
  { id: 'wechat', regex: /(?:微信|weixin|wechat)\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}/, why: '微信号' },
  { id: 'hr-real-name', regex: /(?:HR|hr|面试官)\s*[:：]\s*[\u4e00-\u9fa5]{2,4}(?![公司部岗位])/, why: 'HR / 面试官真实姓名' },
];

const errors = [];
const warnings = [];

function fail(file, message) {
  errors.push(`${file}: ${message}`);
}

function warn(file, message) {
  warnings.push(`${file}: ${message}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJSON(file) {
  const raw = readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(file, `不是合法 JSON（${error.message}）`);
    return null;
  }
}

/** 扫一段文本里的敏感信息，返回命中列表 */
function scanText(text, where) {
  for (const rule of SENSITIVE) {
    const match = text.match(rule.regex);
    if (match) fail(where, `疑似包含${rule.why}：「${match[0]}」—— 请改成「HR」「某 HR」这类脱敏写法`);
  }
}

if (!existsSync(communityDir)) {
  console.error('✗ 找不到 community/ 目录');
  process.exit(1);
}

const files = readdirSync(communityDir)
  .filter((name) => name.endsWith('.json') && name !== '_index.json')
  .sort();

if (files.length === 0) {
  console.error('✗ community/ 里没有任何面经 JSON');
  process.exit(1);
}

const expIds = new Map();
const questionIds = new Map();
const stats = [];

for (const file of files) {
  const absolute = resolve(communityDir, file);
  const data = readJSON(absolute);
  if (!data) continue;

  // 两种形态都接受：{experiences:[...]} 或裸数组
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.experiences) ? data.experiences : null;
  if (!list) {
    fail(file, '顶层必须是数组，或者是带 experiences 数组的对象');
    continue;
  }
  if (list.length === 0) {
    fail(file, 'experiences 是空的 —— 空文件不如不提交');
    continue;
  }

  let questionCount = 0;

  for (const [index, exp] of list.entries()) {
    const where = `${file}#${index + 1}`;
    if (!isRecord(exp)) {
      fail(where, '不是对象');
      continue;
    }

    if (typeof exp.id !== 'string' || !/^[a-z0-9][a-z0-9-]{5,60}$/.test(exp.id)) {
      fail(where, 'id 必须是小写字母/数字/短横线，6–60 字符');
    } else if (expIds.has(exp.id)) {
      fail(where, `id 重复：${exp.id}（已在 ${expIds.get(exp.id)} 出现）`);
    } else {
      expIds.set(exp.id, file);
    }

    if (typeof exp.companyName !== 'string' || !exp.companyName.trim()) {
      fail(where, '缺少 companyName');
    } else {
      if (exp.companyName.length > LIMITS.companyName) {
        fail(where, `companyName 超过 ${LIMITS.companyName} 字`);
      }
      scanText(exp.companyName, `${where}.companyName`);
    }

    if (exp.jobTitle !== undefined) {
      if (typeof exp.jobTitle !== 'string') fail(where, 'jobTitle 必须是字符串');
      else if (exp.jobTitle.length > LIMITS.jobTitle) fail(where, `jobTitle 超过 ${LIMITS.jobTitle} 字`);
    }

    if (exp.round !== undefined && exp.round !== null && (typeof exp.round !== 'number' || exp.round < 1)) {
      fail(where, 'round 必须是 ≥1 的数字或 null');
    }

    if (typeof exp.interviewDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exp.interviewDate)) {
      fail(where, 'interviewDate 必须是 YYYY-MM-DD');
    } else if (Number.isNaN(Date.parse(`${exp.interviewDate}T00:00:00Z`))) {
      fail(where, `interviewDate 不是一个真实日期：${exp.interviewDate}`);
    }

    if (exp.result !== undefined && !RESULTS.has(exp.result)) {
      fail(where, `result 必须是 ${[...RESULTS].join(' / ')}`);
    }

    if (exp.overallNote !== undefined) {
      if (typeof exp.overallNote !== 'string') fail(where, 'overallNote 必须是字符串');
      else {
        if (exp.overallNote.length > LIMITS.overallNote) {
          fail(where, `overallNote 超过 ${LIMITS.overallNote} 字`);
        }
        scanText(exp.overallNote, `${where}.overallNote`);
      }
    }

    if (exp.questions !== undefined) {
      if (!Array.isArray(exp.questions)) {
        fail(where, 'questions 必须是数组');
      } else {
        for (const [qIndex, question] of exp.questions.entries()) {
          const qWhere = `${where}.questions[${qIndex}]`;
          if (!isRecord(question)) {
            fail(qWhere, '不是对象');
            continue;
          }
          questionCount += 1;

          if (question.id !== undefined) {
            if (typeof question.id !== 'string' || !/^[a-z0-9][a-z0-9-]{3,60}$/.test(question.id)) {
              fail(qWhere, 'id 必须是小写字母/数字/短横线，4–60 字符');
            } else if (questionIds.has(question.id)) {
              fail(qWhere, `id 重复：${question.id}（已在 ${questionIds.get(question.id)} 出现）`);
            } else {
              questionIds.set(question.id, file);
            }
          }

          if (typeof question.text !== 'string' || !question.text.trim()) {
            fail(qWhere, '缺少 text');
          } else {
            if (question.text.length > LIMITS.questionText) {
              fail(qWhere, `text 超过 ${LIMITS.questionText} 字`);
            }
            scanText(question.text, `${qWhere}.text`);
          }

          if (question.category !== undefined && question.category !== null && !CATEGORIES.has(question.category)) {
            fail(qWhere, `category 必须是 ${[...CATEGORIES].join(' / ')} 或 null`);
          }

          if (question.difficulty !== undefined && ![1, 2, 3].includes(question.difficulty)) {
            fail(qWhere, 'difficulty 必须是 1 / 2 / 3');
          }

          if (question.myAnswer !== undefined) {
            if (typeof question.myAnswer !== 'string') fail(qWhere, 'myAnswer 必须是字符串');
            else {
              if (question.myAnswer.length > LIMITS.myAnswer) {
                fail(qWhere, `myAnswer 超过 ${LIMITS.myAnswer} 字`);
              }
              scanText(question.myAnswer, `${qWhere}.myAnswer`);
            }
          }

          if (question.nextTime !== undefined && typeof question.nextTime !== 'string') {
            fail(qWhere, 'nextTime 必须是字符串');
          }
          if (question.tags !== undefined && !Array.isArray(question.tags)) {
            fail(qWhere, 'tags 必须是字符串数组');
          }
        }
      }
    }

    stats.push({
      id: typeof exp.id === 'string' ? exp.id : '(no-id)',
      company: typeof exp.companyName === 'string' ? exp.companyName : '(no-company)',
      questionCount: Array.isArray(exp.questions) ? exp.questions.length : 0,
    });
  }
}

/* --------------------------------------------------------- _index.json 一致性 */

const indexPath = resolve(communityDir, '_index.json');
let indexEntries = [];

if (!existsSync(indexPath)) {
  fail('_index.json', '缺失 —— 社区目录必须有一份索引，方便人浏览和程序对账');
} else {
  const indexData = readJSON(indexPath);
  if (indexData) {
    if (!isRecord(indexData)) {
      fail('_index.json', '顶层必须是对象');
    } else {
      if (typeof indexData.version !== 'number') fail('_index.json', 'version 必须是数字');
      if (typeof indexData.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(indexData.updatedAt)) {
        fail('_index.json', 'updatedAt 必须是 YYYY-MM-DD');
      }
      if (!Array.isArray(indexData.entries)) {
        fail('_index.json', 'entries 必须是数组');
      } else {
        indexEntries = indexData.entries;
      }
    }
  }
}

const indexedFiles = new Set();
const indexIds = new Set();

for (const [i, entry] of indexEntries.entries()) {
  const where = `_index.json.entries[${i}]`;
  if (!isRecord(entry)) {
    fail(where, '不是对象');
    continue;
  }
  if (typeof entry.file !== 'string') {
    fail(where, '缺少 file');
    continue;
  }
  if (!files.includes(entry.file)) {
    fail(where, `file 指向的文件不存在：${entry.file}`);
  }
  indexedFiles.add(entry.file);

  if (typeof entry.id !== 'string' || !entry.id) {
    fail(where, '缺少 id');
  } else if (indexIds.has(entry.id)) {
    fail(where, `id 重复：${entry.id}`);
  } else {
    indexIds.add(entry.id);
    if (!expIds.has(entry.id)) {
      fail(where, `id「${entry.id}」在面经文件里找不到 —— 索引和数据对不上`);
    }
  }

  if (typeof entry.questionCount !== 'number') {
    fail(where, '缺少 questionCount');
  } else {
    const actual = stats.find((item) => item.id === entry.id);
    if (actual && actual.questionCount !== entry.questionCount) {
      fail(where, `questionCount=${entry.questionCount}，实际 ${actual.questionCount} 题`);
    }
  }
}

for (const file of files) {
  if (!indexedFiles.has(file)) {
    fail(file, '没有出现在 _index.json 里 —— 加了文件就要更新索引');
  }
}

/* ------------------------------------------------------------------- 输出 */

const totalQuestions = stats.reduce((sum, item) => sum + item.questionCount, 0);
console.log(`检查 community/：${files.length} 个文件 · ${stats.length} 篇面经 · ${totalQuestions} 道题`);

if (warnings.length > 0) {
  console.warn(`\n⚠ ${warnings.length} 条提醒：`);
  for (const message of warnings) console.warn(`  ${message}`);
}

if (errors.length > 0) {
  console.error(`\n✗ ${errors.length} 个问题：`);
  for (const message of errors) console.error(`  ${message}`);
  console.error('\n格式见 community/SCHEMA.md。脱敏规则是硬红线：宁可少写一句，也不要带别人的私人信息。');
  process.exit(1);
}

console.log('✓ 社区面经格式与脱敏检查通过');
