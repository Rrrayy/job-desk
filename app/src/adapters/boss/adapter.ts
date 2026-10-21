/** BOSS 直聘适配器：只声明「这页能不能读」与「怎么解析」，不做别的。 */

import type { SyncAdapter } from '../types';
import { parseBossText } from './parse';

export const bossAdapter: SyncAdapter = {
  id: 'boss',
  name: 'BOSS 直聘',
  platform: 'boss',
  version: '1.1.0',
  /** 2026-10-21 用真机「求职记录」页文本校准（App 我的 → 求职记录 → 沟通过） */
  lastVerifiedAt: '2026-10-21',
  matchUrl: (url: string) => /zhipin\.com\/web\/geek\/(chat|apply)/.test(url),
  urlPattern: 'zhipin.com/web/geek/chat',
  inputType: 'paste',
  parse: parseBossText,
};
