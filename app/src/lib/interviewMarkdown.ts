/**
 * 面经 → Markdown（可一键发牛客 / 小红书）+ 脱敏。
 *
 * 模板见架构 §6.5：
 * - 一场面试一个 `##`；题目 `###` 顺序 = 用户录入顺序（导出是给人看的，不是复习）
 * - 空字段整行省略（不输出 `**我当时答：** ` 这种空壳）
 * - 多场一起导出：`# 公司 面经（N 场）` 作一级标题
 */

import type { InterviewExperience, Question } from '../types';
import {
  CATEGORY_LABEL,
  CATEGORY_NONE_LABEL,
  EXPERIENCE_RESULT_LABEL,
  SOURCE_LABEL,
} from './interview';

export interface MarkdownOptions {
  /** 一键脱敏：手机号 / 邮箱 / 薪资数字 / 面试官姓名 */
  desensitize: boolean;
}

/**
 * 常见单姓。
 *
 * 为什么用白名单而不是 `[\u4e00-\u9fa5]`（QA D6）：
 * 泛匹配「任意 1 个汉字 + 称呼」会把「项目总」「总监老师」这类词的名字部分吃掉，
 * 而「只看是不是姓」能同时做到两件事 —— 单字姓（王老师）不漏，
 * 「前端 / 后端 / 一面 / 二面 / 项目」这些非姓词不误伤。
 * 表里不含「老 / 大 / 小 / 目 / 端」等常见误伤字，宁少勿滥。
 */
const SURNAMES =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻苏潘葛范彭郎鲁韦马苗方俞任袁柳唐薛雷贺倪汤罗毕郝安常傅齐康伍余元顾孟黄萧尹姚邵汪毛狄米贝戴宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封储靳松井段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇甘厉祖武符刘景詹龙叶幸司韶黎白怀蒲鄂索咸赖卓蔺屠蒙池乔翟谭劳姬申扶冉雍桑桂牛寿通边燕冀浦尚农温别庄晏柴瞿阎充连茹习艾容向古易慎戈廖庾居衡步都耿满弘匡国文寇广东欧沃利蔚越师巩聂冷辛那简饶曾沙丰巢关查后荆红游权盖益桓';
export const SURNAME_CHARS = SURNAMES;

/** 「总」后面跟这些字时是普通词（总结 / 总数 / 总共 / 总体…），不当作称呼 */
const ZONG_BLOCK = '结数量额分之体览统部则共有';

/** 薪资：带单位的（15k / 30 万 / 300 元 / 30w），含可选的「/月」 */
const SALARY_WITH_UNIT = /\d+(?:\.\d+)?\s*(?:[kK](?![a-zA-Z])|[wW](?![a-zA-Z])|元|万|千)(?:\s*\/\s*(?:天|月|年|小时))?/g;
/** 薪资：只带时段单位的（200/天、80/小时）—— 没有 k/元/万 也要认 */
const SALARY_WITH_PERIOD = /\d+(?:\.\d+)?\s*\/\s*(?:天|月|年|小时)/g;

/**
 * 脱敏：能识别出「这是个人信息」的模式全部替换掉。
 *
 * 覆盖：手机号 / 邮箱 / 薪资（含「200 元/天」「200/天」「15k」「30 万」）/
 * 面试官姓名（「张三面试官」「王老师」「李总」「王哥」）。
 * 明确**不动**的：前端、后端、一面、二面、项目 —— 名字规则只认常见姓。
 */
export function desensitize(text: string): string {
  if (!text) return '';
  const nameBeforeInterviewer = new RegExp(`[${SURNAME_CHARS}][\\u4e00-\\u9fa5]?(?=面试官)`, 'g');
  const nameBeforeTeacher = new RegExp(`[${SURNAME_CHARS}][\\u4e00-\\u9fa5]?老师`, 'g');
  const nameBeforeZong = new RegExp(`[${SURNAME_CHARS}](?=总(?![${ZONG_BLOCK}]))`, 'g');
  const nameBeforeSibling = new RegExp(`[${SURNAME_CHARS}](?=哥|姐)`, 'g');
  return (
    text
      // 手机号
      .replace(/1[3-9]\d{9}/g, '138****0000')
      // 邮箱
      .replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.]+)/g, '$1***@$2')
      // 薪资：先带单位的，再只带时段的（「300元/天」两支都能吃掉，先跑前一支）
      .replace(SALARY_WITH_UNIT, '<薪资>')
      .replace(SALARY_WITH_PERIOD, '<薪资>')
      // 「张三面试官」→「面试官」
      .replace(nameBeforeInterviewer, '')
      // 「李四老师 / 王老师」→「面试官」
      .replace(nameBeforeTeacher, '面试官')
      // 「王总」→「某总」；「总裁 / 总结」这类词不动
      .replace(nameBeforeZong, '某')
      // 「李哥 / 王姐」→「某哥 / 某姐」
      .replace(nameBeforeSibling, '某')
  );
}

/** 单个题的纯文本（一键复制发给同学用） */
export function renderQuestionPlain(question: Question): string {
  const lines: string[] = [`Q：${question.text}`];
  if (question.myAnswer) lines.push(`A：${question.myAnswer}`);
  if (question.nextTime) lines.push(`下次：${question.nextTime}`);
  return lines.join('\n');
}

function categoryText(question: Question): string {
  return question.category ? CATEGORY_LABEL[question.category] : CATEGORY_NONE_LABEL;
}

/** 单场面经 → Markdown（不含一级标题） */
export function renderExperienceMarkdown(
  experience: InterviewExperience,
  questions: Question[],
  opts: MarkdownOptions,
): string {
  const clean = (value: string): string => (opts.desensitize ? desensitize(value) : value);
  const head = `## ${experience.companyName}${experience.jobTitle ? ` · ${experience.jobTitle}` : ''}${
    experience.round ? ` · 第 ${experience.round} 轮` : ''
  }（${experience.interviewDate}）`;

  const meta: string[] = [];
  meta.push(`- 结果：${EXPERIENCE_RESULT_LABEL[experience.result]}`);
  meta.push(`- 来源：${SOURCE_LABEL[experience.source]}（\`${experience.source}\`）`);

  const blocks: string[] = [head, '', ...meta];
  if (experience.overallNote) {
    blocks.push('', `> ${clean(experience.overallNote).split('\n').join('\n> ')}`);
  }

  questions.forEach((question, index) => {
    blocks.push('');
    blocks.push(
      `### Q${index + 1} · ${categoryText(question)} · 难度 ${question.difficulty} · 掌握度 ${question.mastery}/2`,
    );
    blocks.push('');
    blocks.push(`**Q：${clean(question.text)}**`);
    blocks.push('');
    if (question.myAnswer) {
      blocks.push(`**我当时答：** ${clean(question.myAnswer)}`);
      blocks.push('');
    }
    if (question.rootCause) {
      blocks.push(`**复盘：** ${rootCauseText(question)}`);
    }
    if (question.nextTime) {
      blocks.push(`**下次：** ${clean(question.nextTime)}`);
    }
    if (question.tags.length > 0) {
      blocks.push('');
      blocks.push(`\`标签：${question.tags.join('、')}\``);
    }
  });

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function rootCauseText(question: Question): string {
  const map: Record<string, string> = {
    conceptGap: '概念没懂',
    forgot: '写过但忘了',
    nervous: '紧张',
    misread: '没听懂题',
    neverSeen: '没见过这类题',
  };
  return question.rootCause ? map[question.rootCause] ?? '' : '';
}

/** 多场面经 → 一份 Markdown（同一家公司时用一级标题聚合） */
export function renderManyMarkdown(
  experiences: InterviewExperience[],
  questionsByExperience: Map<string, Question[]>,
  opts: MarkdownOptions,
): string {
  if (experiences.length === 0) return '# 面经\n\n（还没有可以导出的面经）\n';
  const companies = new Set(experiences.map((experience) => experience.companyName));
  const title =
    companies.size === 1
      ? `# ${experiences[0].companyName} 面经（${experiences.length} 场）`
      : `# 面经（${experiences.length} 场）`;

  const body = experiences
    .map((experience) =>
      renderExperienceMarkdown(experience, questionsByExperience.get(experience.id) ?? [], opts),
    )
    .join('\n\n');

  return `${title}\n\n${body}\n`;
}

/** 导出文件名：抖音-前端-2025-03-12-面经.md */
export function markdownFileName(experience: InterviewExperience): string {
  const parts = [experience.companyName, experience.jobTitle ?? '', experience.interviewDate, '面经'].filter(
    Boolean,
  );
  return `${parts.join('-').replace(/[\\/:*?"<>|\s]+/g, '-')}.md`;
}
