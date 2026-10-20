/** 实习僧适配器（P1，社区可维护）。 */

import type { SyncAdapter } from '../types';
import { parseShixisengText } from './parse';

export const shixisengAdapter: SyncAdapter = {
  id: 'shixiseng',
  name: '实习僧',
  platform: 'shixiseng',
  version: '1.0.0',
  lastVerifiedAt: '2025-03-01',
  matchUrl: (url: string) => /shixiseng\.com\/(my|delivery|wodeliuyan|applications)/.test(url),
  urlPattern: 'shixiseng.com/my/delivery',
  inputType: 'paste',
  parse: parseShixisengText,
};
