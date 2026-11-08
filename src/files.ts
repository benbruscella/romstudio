import { open } from 'node:fs/promises';
import { Diagnostic } from './core.js';

/** Bound allocation and reads even if an input file grows while it is being read. */
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Diagnostic('INPUT_TYPE', `Expected a regular file: ${path}`);
    }
    if (stat.size > limit) {
      throw new Diagnostic('INPUT_SIZE', `Input '${path}' exceeds the ${limit}-byte limit.`);
    }
    // Retained small-file buffers must not each reserve the entire maximum
    // input size. One extra byte detects growth while preserving the bound.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) {
        break;
      }
      length += result.bytesRead;
    }
    if (length > limit) {
      throw new Diagnostic('INPUT_SIZE', `Input '${path}' exceeds the ${limit}-byte limit.`);
    }
    if (length > stat.size) {
      throw new Diagnostic('INPUT_CHANGED', `Input '${path}' grew while it was being read.`);
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}
