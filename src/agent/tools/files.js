/**
 * 文件类工具：read_file / write_file / list_dir / search_files。
 * 所有路径都过 security.boundary.checkPath；读写都有大小上限。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeTextAtomic } from '../../util/io.js';
import { assertNotAborted, boundaryOf, requireArg, safePath, ToolError, truncateWithNote } from './error.js';
import { t } from '../../i18n/index.js';

const MAX_TEXT_CHARS = 20000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', '.venv', '__pycache__', 'coverage']);
const MAX_SCAN_BYTES = 262144;
const MAX_WALK_DEPTH = 8;

function toRelative(root, full) {
  const rel = path.relative(root, full);
  return rel.split(path.sep).join('/');
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function createFileTools({ config, services }) {
  const rootDir = () => config?.boundaryRoot ?? config?.rootDir ?? process.cwd();
  const boundary = () => boundaryOf(services);
  const maxReadBytes = () => Math.max(1, Number(config?.security?.boundary?.maxReadBytes ?? 1048576));
  const maxWriteBytes = () => Math.max(1, Number(config?.security?.boundary?.maxWriteBytes ?? 262144));

  async function readFileRun(args, ctx) {
    assertNotAborted(ctx);
    const target = safePath(boundary(), requireArg(args, 'path', { type: 'string' }));
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ToolError(t('agent.files.notFound', { path: target }), 'not_found', { path: target });
      throw new ToolError(t('agent.files.readFailed', { message: error.message }), 'io_error', { path: target });
    }
    if (stat.isDirectory()) throw new ToolError(t('agent.files.isDirectory', { path: target }), 'not_a_file', { path: target });
    const limit = maxReadBytes();
    if (stat.size > limit) {
      throw new ToolError(t('agent.files.tooLarge', { size: stat.size, limit }), 'file_too_large', { path: target, size: stat.size });
    }
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) {
      return { ok: true, path: target, bytes: stat.size, binary: true, content: t('agent.files.binary'), truncated: false };
    }
    const text = buffer.toString('utf8');
    const requested = Number(args?.maxChars);
    const maxChars = Math.min(Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : MAX_TEXT_CHARS, MAX_TEXT_CHARS);
    const { text: content, truncated } = truncateWithNote(text, maxChars);
    return { ok: true, path: target, bytes: stat.size, content, truncated };
  }

  async function writeFileRun(args, ctx) {
    assertNotAborted(ctx);
    const target = safePath(boundary(), requireArg(args, 'path', { type: 'string' }));
    const content = requireArg(args, 'content', { type: 'string', allowEmpty: true });
    const bytes = Buffer.byteLength(content, 'utf8');
    const limit = maxWriteBytes();
    if (bytes > limit) {
      throw new ToolError(t('agent.files.contentTooLarge', { bytes, limit }), 'content_too_large', { path: target, bytes, limit });
    }
    await ensureDir(path.dirname(target));
    await writeTextAtomic(target, content);
    return { ok: true, path: target, bytes };
  }

  async function listDirRun(args, ctx) {
    assertNotAborted(ctx);
    const sandbox = boundary();
    const target = safePath(sandbox, args?.path ? String(args.path) : rootDir());
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ToolError(t('agent.files.dirNotFound', { path: target }), 'not_found', { path: target });
      throw new ToolError(t('agent.files.listFailed', { message: error.message }), 'io_error', { path: target });
    }
    if (!stat.isDirectory()) throw new ToolError(t('agent.files.notADirectory', { path: target }), 'not_a_directory', { path: target });

    const recursive = args?.recursive === true;
    const keyword = args?.match ? String(args.match).toLowerCase() : null;
    const limit = Math.min(Math.max(Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 200, 1), 1000);
    const entries = [];

    async function walk(dir, depth) {
      if (entries.length >= limit) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        entries.push({ path: `${toRelative(target, dir)}/`, type: 'error', error: error.message });
        return;
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (entries.length >= limit) return;
        if (SKIP_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        const rel = toRelative(target, full);
        if (keyword && !rel.toLowerCase().includes(keyword)) {
          // 目录名不匹配时仍要往下走，只跳过记录
          if (item.isDirectory() && recursive && depth < MAX_WALK_DEPTH) await walk(full, depth + 1);
          continue;
        }
        if (item.isDirectory()) {
          entries.push({ path: `${rel}/`, type: 'dir' });
          if (recursive && depth < MAX_WALK_DEPTH) await walk(full, depth + 1);
        } else if (item.isFile()) {
          const info = await fs.stat(full).catch(() => null);
          entries.push({ path: rel, type: 'file', size: info?.size ?? null });
        } else {
          entries.push({ path: rel, type: 'other' });
        }
      }
    }

    await walk(target, 0);
    return {
      ok: true,
      path: target,
      count: entries.length,
      truncated: entries.length >= limit,
      entries,
    };
  }

  async function searchFilesRun(args, ctx) {
    assertNotAborted(ctx);
    const pattern = requireArg(args, 'pattern', { type: 'string' });
    const sandbox = boundary();
    const target = safePath(sandbox, args?.path ? String(args.path) : rootDir());
    const recursive = args?.recursive !== false;
    const maxResults = Math.min(Math.max(Number(args?.maxResults) > 0 ? Math.trunc(Number(args.maxResults)) : 50, 1), 200);
    const searchContent = args?.content === true;
    const glob = /[*?]/.test(pattern);
    const matcher = glob ? globToRegExp(path.basename(pattern)) : null;
    const needle = glob ? null : pattern.toLowerCase();
    const results = [];

    async function walk(dir, depth) {
      if (results.length >= maxResults) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (results.length >= maxResults) return;
        if (SKIP_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (recursive && depth < MAX_WALK_DEPTH) await walk(full, depth + 1);
          continue;
        }
        if (!item.isFile()) continue;
        const rel = toRelative(target, full);
        const nameHit = glob ? matcher.test(item.name) : item.name.toLowerCase().includes(needle);
        if (nameHit) {
          const info = await fs.stat(full).catch(() => null);
          results.push({ path: rel, type: 'name', size: info?.size ?? null });
          continue;
        }
        if (!searchContent) continue;
        const info = await fs.stat(full).catch(() => null);
        if (!info || info.size > MAX_SCAN_BYTES) continue;
        const buffer = await fs.readFile(full).catch(() => null);
        if (!buffer || buffer.includes(0)) continue;
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].toLowerCase().includes(String(pattern).toLowerCase())) continue;
          results.push({ path: rel, type: 'content', line: i + 1, preview: lines[i].trim().slice(0, 200) });
          break;
        }
        if (results.length >= maxResults) return;
      }
    }

    await walk(target, 0);
    return { ok: true, pattern, path: target, count: results.length, truncated: results.length >= maxResults, results };
  }

  const readFile = {
    name: 'read_file',
    description: t('agent.files.readFile.description'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: t('agent.files.readFile.path') },
        maxChars: { type: 'number', description: t('agent.files.readFile.maxChars') },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitive: true,
    action: 'file_read',
    run: readFileRun,
  };

  const writeFile = {
    name: 'write_file',
    description: t('agent.files.writeFile.description'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: t('agent.files.writeFile.path') },
        content: { type: 'string', description: t('agent.files.writeFile.content') },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    sensitive: true,
    action: 'file_write',
    run: writeFileRun,
  };

  const listDir = {
    name: 'list_dir',
    description: t('agent.files.listDir.description'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: t('agent.files.listDir.path') },
        recursive: { type: 'boolean', description: t('agent.files.listDir.recursive') },
        match: { type: 'string', description: t('agent.files.listDir.match') },
        limit: { type: 'number', description: t('agent.files.listDir.limit') },
      },
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: listDirRun,
  };

  const searchFiles = {
    name: 'search_files',
    description: t('agent.files.searchFiles.description'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: t('agent.files.searchFiles.pattern') },
        path: { type: 'string', description: t('agent.files.searchFiles.path') },
        recursive: { type: 'boolean', description: t('agent.files.searchFiles.recursive') },
        content: { type: 'boolean', description: t('agent.files.searchFiles.content') },
        maxResults: { type: 'number', description: t('agent.files.searchFiles.maxResults') },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: searchFilesRun,
  };

  return [readFile, writeFile, listDir, searchFiles];
}
