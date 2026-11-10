import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { readBounded } from '../files.js';
import { repositoryRoot, gameSourceDirectory } from '../paths.js';
import type { GameKey } from '../game-id.js';

export interface LearningMaterial {
  chapters: { slug: string; title: string; html: string }[];
  code: { name: string; purpose: string; text: string }[];
}
const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Render our documentation, escaping HTML and allowing only ordinary links.
 * Game data and ROM bytes never enter markup. No browser Markdown dependency. */
export function renderMarkdown(
  markdown: string,
  link: (href: string) => string = (href) => href,
): string {
  const inline = (text: string): string => {
    const tokens: string[] = [];
    const save = (value: string) => `\uE000${tokens.push(value) - 1}\uE000`;
    let html = escapeHtml(
      text.replace(/`([^`]+)`/g, (_all, code: string) => save(`<code>${escapeHtml(code)}</code>`)),
    );
    html = html
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_all, label: string, target: string) => {
        const href = link(target);
        return /^(?:https?:\/\/|\/|\.\/|#)/.test(href)
          ? `<a href="${escapeHtml(href)}">${label}</a>`
          : label;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return html.replace(/\uE000(\d+)\uE000/g, (_all, index: string) => tokens[Number(index)]!);
  };
  const lines = markdown.split(/\r?\n/),
    output: string[] = [];
  let paragraph: string[] = [],
    code: string[] | undefined,
    list = '';
  const flush = () => {
    if (paragraph.length) {
      output.push(`<p>${inline(paragraph.join(' '))}</p>`);
    }
    paragraph = [];
  };
  const closeList = () => {
    if (list) {
      output.push(`</${list}>`);
    }
    list = '';
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      flush();
      closeList();
      if (code) {
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      closeList();
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      flush();
      closeList();
      const level = Math.min(6, heading[1]!.length + 1);
      output.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[index + 1] ?? '')) {
      flush();
      closeList();
      const cells = (row: string) =>
        row
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim());
      output.push(
        '<div class="table-scroll"><table><thead><tr>' +
          cells(line)
            .map((cell) => `<th>${inline(cell)}</th>`)
            .join('') +
          '</tr></thead><tbody>',
      );
      index++;
      while (lines[index + 1]?.startsWith('|')) {
        output.push(
          '<tr>' +
            cells(lines[++index]!)
              .map((cell) => `<td>${inline(cell)}</td>`)
              .join('') +
            '</tr>',
        );
      }
      output.push('</tbody></table></div>');
      continue;
    }
    const item = /^(?:([-*]) |\d+\. )(.*)$/.exec(line);
    if (item) {
      flush();
      const type = item[1] ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        list = type;
        output.push(`<${list}>`);
      }
      output.push(`<li>${inline(item[2]!)}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  closeList();
  if (code) {
    output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  }
  return output.join('\n');
}

export async function gameLearning(id: GameKey, route: string): Promise<LearningMaterial> {
  const directory = gameSourceDirectory(id),
    docs = join(directory, 'docs');
  let chapters: string[] = [];
  try {
    chapters = (await readdir(docs))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(docs, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const paths = [join(directory, 'README.md'), ...chapters],
    slugs = new Map(
      paths.map((path) => [
        path,
        basename(path) === 'README.md' ? 'overview' : basename(path, '.md').toLowerCase(),
      ]),
    );
  const material: LearningMaterial = { chapters: [], code: [] };
  for (const path of paths) {
    const markdown = (await readBounded(path, 1048576)).toString();
    const html = renderMarkdown(markdown, (href) => {
      if (/^https?:\/\//.test(href) || href.startsWith('#')) {
        return href;
      }
      const target = resolve(dirname(path), href.split('#')[0]!);
      if (slugs.has(target)) {
        return `${route}/learn/${slugs.get(target)}`;
      }
      return `https://github.com/benbruscella/romstudio/blob/main/${relative(repositoryRoot, target).split('/').map(encodeURIComponent).join('/')}`;
    });
    material.chapters.push({
      slug: slugs.get(path)!,
      title: /^# (.+)$/m.exec(markdown)?.[1] ?? basename(path, '.md'),
      html,
    });
  }
  for (const [folder, purpose] of [
    ['code', 'Named interpretation linked to original assembly; not browser UI.'],
    ['web', 'Browser adapter: labels and input wiring, separate from the original game rules.'],
  ] as const) {
    let names: string[] = [];
    try {
      names = await readdir(join(directory, folder));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    for (const name of names
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort()) {
      material.code.push({
        name: `${folder}/${name}`,
        purpose,
        text: (await readBounded(join(directory, folder, name), 1048576)).toString(),
      });
    }
  }
  return material;
}
