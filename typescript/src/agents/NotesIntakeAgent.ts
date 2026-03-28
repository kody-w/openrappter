import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { readdir, readFile } from 'fs/promises';
import { join, extname, basename } from 'path';

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const TAG_PATTERN = /#([a-zA-Z][\w-/]*)/g;
const UNCHECKED = /^[\s]*- \[ \]\s+(.+)/;
const CHECKED = /^[\s]*- \[x\]\s+(.+)/i;

interface ActionItem { text: string; file: string; line: number; urgency: 'high' | 'medium' | 'low'; date?: string; tags: string[]; }

export class NotesIntakeAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = { name: 'NotesIntake', description: 'Scans an Obsidian vault or notes directory, extracts action items, tags, and identifies smart reminders by urgency.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Notes directory or Obsidian vault path' }, query: { type: 'string', description: 'Natural language query' } }, required: ['path'] } };
    super('NotesIntake', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const notesPath = kwargs.path as string;
    if (!notesPath) return JSON.stringify({ status: 'error', message: 'path is required' });
    try {
      const mdFiles = await this.findMarkdownFiles(notesPath);
      const actionItems: ActionItem[] = [];
      let completedCount = 0;
      const allTags = new Set<string>();
      for (const filePath of mdFiles.slice(0, 100)) {
        let content: string; try { content = await readFile(filePath, 'utf-8'); } catch { continue; }
        const lines = content.split('\n'); const fileName = basename(filePath);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]; let tagMatch; TAG_PATTERN.lastIndex = 0;
          while ((tagMatch = TAG_PATTERN.exec(line)) !== null) allTags.add(tagMatch[1]);
          if (CHECKED.test(line)) { completedCount++; continue; }
          const unchecked = UNCHECKED.exec(line);
          if (unchecked) { const text = unchecked[1].trim(); const dateMatch = ISO_DATE.exec(text); const lineTags: string[] = []; TAG_PATTERN.lastIndex = 0; let lt; while ((lt = TAG_PATTERN.exec(text)) !== null) lineTags.push(lt[1]); actionItems.push({ text, file: fileName, line: i + 1, urgency: this.computeUrgency(dateMatch?.[0], lineTags), date: dateMatch?.[0], tags: lineTags }); }
        }
      }
      const highUrgency = actionItems.filter(a => a.urgency === 'high');
      const tagsArray = Array.from(allTags).sort();
      return JSON.stringify({ status: 'success', notes_scanned: mdFiles.length, action_items: actionItems, completed_count: completedCount, reminders: highUrgency, tags: tagsArray, data_slush: { source_agent: 'NotesIntake', action_item_count: actionItems.length, completed_count: completedCount, high_urgency_count: highUrgency.length, tags_found: tagsArray.slice(0, 20), notes_scanned: mdFiles.length } });
    } catch (err) { return JSON.stringify({ status: 'error', message: `Failed to scan notes: ${(err as Error).message}` }); }
  }

  private computeUrgency(dateStr: string | undefined, tags: string[]): 'high' | 'medium' | 'low' {
    if (dateStr) { const d = (new Date(dateStr).getTime() - Date.now()) / 86400000; if (d <= 3) return 'high'; if (d <= 7) return 'medium'; }
    if (tags.some(t => ['important', 'urgent', 'critical', 'asap', 'blocker'].includes(t.toLowerCase()))) return 'medium';
    return 'low';
  }

  private async findMarkdownFiles(dirPath: string, depth = 0): Promise<string[]> {
    if (depth > 4) return []; const results: string[] = []; let entries; try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return []; }
    for (const entry of entries) { if (results.length >= 200) break; const fullPath = join(dirPath, entry.name); if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') results.push(...await this.findMarkdownFiles(fullPath, depth + 1)); else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') results.push(fullPath); }
    return results;
  }
}
