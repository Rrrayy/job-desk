/** 牛客适配器（P1，社区可维护）。 */

import type { SyncAdapter } from '../types';
import { parseNowcoderText } from './parse';

export const nowcoderAdapter: SyncAdapter = {
  id: 'nowcoder',
  name: '牛客',
  platform: 'nowcoder',
  version: '1.0.0',
  lastVerifiedAt: '2025-03-01',
  matchUrl: (url: string) => /nowcoder\.com\/(my|applications|deliver)/.test(url),
  urlPattern: 'nowcoder.com/my/applications',
  inputType: 'paste',
  parse: parseNowcoderText,
};
