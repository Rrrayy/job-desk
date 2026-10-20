/** custom 兜底适配器（P1）：任何页面/表格都能试一下，永远排在注册表最后。 */

import type { SyncAdapter } from '../types';
import { parseCustomText } from './parse';

export const customAdapter: SyncAdapter = {
  id: 'custom',
  name: '通用表格 / 其他平台',
  platform: 'custom',
  version: '1.0.0',
  lastVerifiedAt: '2025-03-01',
  matchUrl: undefined,
  urlPattern: '任意页面的列表 / 表格',
  inputType: 'paste',
  parse: parseCustomText,
};
