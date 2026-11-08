import { createHash } from 'node:crypto';

export * from './contracts.js';
export const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
