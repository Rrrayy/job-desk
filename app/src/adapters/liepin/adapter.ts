/** 猎聘适配器：只声明「这页能不能读」与「怎么解析」，不做别的。 */

import type { SyncAdapter } from '../types';
import { parseLiepinText } from './parse';

export const liepinAdapter: SyncAdapter = {
  id: 'liepin',
  name: '猎聘',
  platform: 'liepin',
  version: '1.0.0',
  /** 2026-10-21 用真机职位详情页文本校准；列表页尚未验证 */
  lastVerifiedAt: '2026-10-21',
  matchUrl: (url: string) => /liepin\.com/.test(url),
  urlPattern: 'liepin.com',
  inputType: 'paste',
  parse: parseLiepinText,
};
