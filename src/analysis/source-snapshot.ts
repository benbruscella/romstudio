import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { Diagnostic, sha256 } from '../core.js';
import { readBounded } from '../files.js';
import { repositoryRoot } from '../paths.js';

export interface SourceSnapshot {
  schemaVersion: 1;
  roots: string[];
  compiledDirectory: string;
  configuration: string[];
  environment: { node: string; typescript: string };
  files: Record<string, string>;
}

/** Find actual module references, rather than matching imports in comments or
 * generated-source strings. Worker entry URLs also belong to the closure. */
function moduleReferences(text: string, name: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    let reference: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      reference = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      reference = node.arguments[0];
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      moduleUrl(node.arguments?.[1])
    ) {
      reference = node.arguments?.[0];
      // Directory roots and asset URLs are not executable module entries.
      if (
        !reference ||
        !ts.isStringLiteralLike(reference) ||
        !/\.(?:js|ts)$/.test(reference.text)
      ) {
        reference = undefined;
      }
    }
    if (reference && ts.isStringLiteralLike(reference)) {
      found.add(reference.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

function moduleUrl(node: ts.Expression | undefined): boolean {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** Node-only build evidence. Hash both source and emitted code, following the
 * union of their dependency graphs so stale compiled imports are not hidden.
 * This is tooling AST use, distinct from a future binary instruction IR. */
export async function sourceSnapshot(
  roots: readonly string[],
  options: { root?: string; compiledDirectory?: string; configuration?: readonly string[] } = {},
): Promise<SourceSnapshot> {
  const root = await realpath(options.root ?? repositoryRoot),
    compiledDirectory = options.compiledDirectory ?? 'dist/tools',
    configuration = [
      ...(options.configuration ?? ['tsconfig.json', 'package.json', 'package-lock.json']),
    ].sort(),
    files = new Map<string, string>(),
    visited = new Set<string>();
  const pathWithinRoot = (name: string): string => {
    const path = resolve(root, name);
    if (!path.startsWith(root + sep) || name.includes('\\')) {
      throw new Diagnostic('SOURCE_PATH', 'Model dependencies must stay inside the project.');
    }
    return path;
  };
  const read = async (name: string): Promise<string> => {
    if (files.size >= 4096) {
      throw new Diagnostic('SOURCE_LIMIT', 'Too many model source files.');
    }
    const path = pathWithinRoot(name),
      actual = await realpath(path);
    if (!actual.startsWith(root + sep)) {
      throw new Diagnostic('SOURCE_PATH', 'Model dependencies cannot link outside the project.');
    }
    const bytes = await readBounded(path, 2097152);
    files.set(relative(root, path).split(sep).join('/'), sha256(bytes));
    return bytes.toString();
  };
  const visit = async (name: string): Promise<void> => {
    const sourcePath = relative(root, pathWithinRoot(name)).split(sep).join('/');
    if (!sourcePath.startsWith('src/') || !sourcePath.endsWith('.ts')) {
      throw new Diagnostic('SOURCE_MODULE', `Expected a TypeScript source module: ${name}.`);
    }
    if (visited.has(sourcePath)) {
      return;
    }
    visited.add(sourcePath);
    const texts = [await read(sourcePath)];
    if (!sourcePath.endsWith('.d.ts')) {
      texts.push(await read(`${compiledDirectory}/${sourcePath.replace(/\.ts$/, '.js')}`));
    }
    const references = new Set(texts.flatMap((text) => moduleReferences(text, sourcePath)));
    for (const reference of [...references].sort()) {
      if (reference.startsWith('/')) {
        throw new Diagnostic('SOURCE_MODULE', 'Absolute module paths are not reproducible.');
      }
      if (!reference.startsWith('.')) {
        continue;
      } // Node built-ins/packages: runtime and lockfile pinned below.
      if (!/\.(?:js|ts)$/.test(reference)) {
        throw new Diagnostic('SOURCE_MODULE', `Untracked model dependency: ${reference}.`);
      }
      await visit(
        relative(root, resolve(root, dirname(sourcePath), reference.replace(/\.js$/, '.ts'))),
      );
    }
  };
  if (!roots.length) {
    throw new Diagnostic('SOURCE_MODULE', 'Choose a model source root.');
  }
  for (const name of [...roots].sort()) {
    await visit(name);
  }
  for (const name of configuration) {
    await read(name);
  }
  return {
    schemaVersion: 1,
    roots: [...roots].sort(),
    compiledDirectory,
    configuration,
    environment: { node: process.version, typescript: ts.version },
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Recheck after analysis and before packaging. A source/compiler change is a
 * failed comparison, never permission to relabel earlier evidence. */
export async function assertSourceSnapshot(snapshot: SourceSnapshot, root?: string): Promise<void> {
  if (snapshot.schemaVersion !== 1) {
    throw new Diagnostic('SOURCE_SNAPSHOT', 'Rebuild the model source snapshot.');
  }
  const current = await sourceSnapshot(snapshot.roots, {
    ...(root ? { root } : {}),
    compiledDirectory: snapshot.compiledDirectory,
    configuration: snapshot.configuration,
  });
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    throw new Diagnostic(
      'SOURCE_CHANGED',
      'Model source, compiled code or build environment changed. Recompile and reverify.',
    );
  }
}
