/** 文件读写：JSON / JSONL / 原子写。 */

import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** 先写临时文件再 rename，避免半截文件。 */
export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export async function writeTextAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendJsonl(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(obj)}\n`, 'utf8');
  return obj;
}

/** 重写整个 JSONL 文件（用于记忆遗忘后的压缩）。 */
export async function rewriteJsonl(file, rows) {
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  return writeTextAtomic(file, text ? `${text}\n` : '');
}

export async function listFiles(dir, { recursive = false, filter = null } = {}) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await listFiles(full, { recursive, filter })));
      continue;
    }
    if (!filter || filter(full)) out.push(full);
  }
  return out;
}

export async function removeFile(file) {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
