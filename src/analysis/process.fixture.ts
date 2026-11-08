import { serveAnalysis } from './process.js';
serveAnalysis<{ action: string; bytes: Uint8Array }, { bytes: Uint8Array }>(async (input) => {
  if (input.action === 'crash') {
    process.exit(7);
  }
  if (input.action === 'error') {
    throw new Error('Fixture analysis failed.');
  }
  return { bytes: input.bytes };
});
