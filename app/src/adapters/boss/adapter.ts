/** BOSS 直聘适配器：只声明「这页能不能读」与「怎么解析」，不做别的。 */

import type { SyncAdapter } from '../types';
import { parseBossText } from './parse';

export const bossAdapter: SyncAdapter = {
  id: 'boss',
  name: 'BOSS 直聘',
  platform: 'boss',
  version: '1.0.0',
  /** 用户自行验证页面结构后可以改这一行；超过 6 个月 UI 会标「可能已失效」 */
  lastVerifiedAt: '2025-03-01',
  matchUrl: (url: string) => /zhipin\.com\/web\/geek\/(chat|apply)/.test(url),
  urlPattern: 'zhipin.com/web/geek/chat',
  inputType: 'paste',
  parse: parseBossText,
};
