import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { readdir, stat, readFile } from 'fs/promises';
import { join, extname, basename } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const TEXT_EXTS = new Set(['.md', '.txt', '.rst', '.org', '.adoc', '.tex']);
const TODO_PATTERN = /(?:TODO|FIXME|HACK|XXX|BUG)[\s:]+(.+)/gi;
const MAX_FILES = 500;
const MAX_READ_BYTES = 10240;

interface FileInfo { path: string; name: string; ext: string; size: number; mtimeMs: number; }

export class DocScannerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = { name: 'DocScanner', description: 'Scans a directory for documents and notes, reporting file count, types, recent changes, and TODOs found.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory to scan' }, query: { type: 'string', description: 'Natural language query' } }, required: ['path'] } };
    super('DocScanner', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const dirPath = kwargs.path as string;
    if (!dirPath) return JSON.stringify({ status: 'error', message: 'path is required' });
    try {
      const files = await this.scanDirectory(dirPath);
      const fileTypes: Record<string, number> = {};
      for (const f of files) { const ext = f.ext || '(no ext)'; fileTypes[ext] = (fileTypes[ext] || 0) + 1; }
      const recentFiles = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5).map(f => ({ name: f.name, path: f.path, modified: new Date(f.mtimeMs).toISOString() }));
      const todos = await this.extractTodos(files.filter(f => TEXT_EXTS.has(f.ext)));
      return JSON.stringify({ status: 'success', summary: { total_files: files.length, file_types: fileTypes, recent_files: recentFiles, todos }, data_slush: { source_agent: 'DocScanner', total_files: files.length, todo_count: todos.length, recent_files: recentFiles.map(f => f.name), file_types: fileTypes } });
    } catch (err) { return JSON.stringify({ status: 'error', message: `Failed to scan: ${(err as Error).message}` }); }
  }

  private async scanDirectory(dirPath: string, depth = 0): Promise<FileInfo[]> {
    if (depth > 5) return [];
    const results: FileInfo[] = [];
    let entries; try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return []; }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) { results.push(...await this.scanDirectory(join(dirPath, entry.name), depth + 1)); }
      else if (entry.isFile()) { try { const p = join(dirPath, entry.name); const s = await stat(p); results.push({ path: p, name: entry.name, ext: extname(entry.name).toLowerCase(), size: s.size, mtimeMs: s.mtimeMs }); } catch { /* skip */ } }
    }
    return results;
  }

  private async extractTodos(files: FileInfo[]): Promise<Array<{ file: string; line: string; match: string }>> {
    const todos: Array<{ file: string; line: string; match: string }> = [];
    for (const f of files.slice(0, 50)) {
      try { const lines = (await readFile(f.path, 'utf-8')).slice(0, MAX_READ_BYTES).split('\n'); for (let i = 0; i < lines.length; i++) { let m; TODO_PATTERN.lastIndex = 0; while ((m = TODO_PATTERN.exec(lines[i])) !== null) todos.push({ file: basename(f.path), line: `${i + 1}`, match: m[0].trim() }); } } catch { /* skip */ }
    }
    return todos;
  }
}
