import { posix } from 'node:path';
import { Diagnostic } from '../core.js';

/** Check the literal imports in our emitted JavaScript before publishing a
 * package. Variable imports use the explicitly declared program/title entries.
 * This scans trusted compiler output, rather than accepting arbitrary JS input. */
export function verifyWebImports(sources: ReadonlyMap<string, string>): void {
  for (const [file, source] of sources) {
    if (/\b(?:eval|new\s+Function)\s*\(/.test(source)) {
      throw new Diagnostic('WEB_COMPILER', `Runtime code generation is not allowed in ${file}.`);
    }
    const references = [
      ...source.matchAll(/^\s*(?:import|export)\s+[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const reference of references) {
      const specifier = reference[1]!;
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!specifier.startsWith('.') || !sources.has(target)) {
        throw new Diagnostic(
          'WEB_IMPORT',
          `Missing browser module ${specifier} imported by ${file}.`,
        );
      }
    }
  }
}
