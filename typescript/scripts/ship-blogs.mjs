/**
 * Ship Blog Posts — Autonomous WordPress Publisher
 *
 * Fetches markdown from GitHub raw, converts to HTML,
 * publishes to kodyw.com via XML-RPC, generates report.
 *
 * Usage:
 *   node scripts/ship-blogs.mjs <username> <password>
 *   node scripts/ship-blogs.mjs <username> <password> --draft  (creates drafts instead of publishing)
 */

import { readFileSync } from 'fs';

const WP_URL = 'https://kodyw.com/xmlrpc.php';
const GITHUB_RAW = 'https://raw.githubusercontent.com/kody-w/openrappter/main/docs/blog';

const POSTS = [
  {
    slug: 'ai-2-0-the-moment-agents-stopped-asking-permission',
    title: 'AI 2.0: The Moment Agents Stopped Asking Permission',
    file: 'ai-2-0-the-moment-agents-stopped-asking-permission.md',
    categories: ['AI', 'Thought Leadership'],
    tags: ['ai-2-0', 'rappsignal', 'digital-twin', 'encryption', 'agents'],
  },
  {
    slug: 'why-ai-messaging-needs-three-layers-of-privacy',
    title: 'Why AI Messaging Needs Three Layers of Privacy (Not Just Encryption)',
    file: 'why-ai-messaging-needs-three-layers-of-privacy.md',
    categories: ['AI', 'Security'],
    tags: ['encryption', 'pii', 'privacy', 'rappsignal', 'e2e'],
  },
  {
    slug: 'the-end-of-server-dependent-messaging',
    title: 'The End of Server-Dependent Messaging',
    file: 'the-end-of-server-dependent-messaging.md',
    categories: ['AI', 'Architecture'],
    tags: ['static-files', 'edge-sync', 'serverless', 'rappsignal'],
  },
  {
    slug: 'every-app-is-a-digital-twin',
    title: 'Every App Is a Digital Twin',
    file: 'every-app-is-a-digital-twin.md',
    categories: ['AI', 'Vision'],
    tags: ['digital-twin', 'platform', 'rappsignal', 'local-first'],
  },
];

// ── Markdown → HTML ──
function md2html(md) {
  // Strip title line and author line
  md = md.replace(/^# .+\n+/, '');
  md = md.replace(/^\*Kody Wildfeuer.+\*\n*/m, '');
  md = md.replace(/^---\n*/gm, '<hr>\n');

  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '</p>\n<p>')
    .replace(/^(?!<[hulo]|<li|<hr|<\/p)(.+)$/gm, '<p>$1</p>')
    .replace(/<p><\/p>/g, '')
    .replace(/<p>\s*<hr>\s*<\/p>/g, '<hr>');
}

// ── XML-RPC call ──
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function xmlRpcCall(method, params) {
  const paramXml = params.map(p => {
    if (typeof p === 'string') return `<param><value><string>${xmlEscape(p)}</string></value></param>`;
    if (typeof p === 'number') return `<param><value><int>${p}</int></value></param>`;
    if (typeof p === 'boolean') return `<param><value><boolean>${p ? 1 : 0}</boolean></value></param>`;
    if (typeof p === 'object' && !Array.isArray(p)) {
      const members = Object.entries(p).map(([k, v]) => {
        let valXml;
        if (typeof v === 'string') valXml = `<string>${xmlEscape(v)}</string>`;
        else if (typeof v === 'number') valXml = `<int>${v}</int>`;
        else if (typeof v === 'boolean') valXml = `<boolean>${v ? 1 : 0}</boolean>`;
        else if (Array.isArray(v)) {
          const items = v.map(i => `<value><string>${xmlEscape(String(i))}</string></value>`).join('');
          valXml = `<array><data>${items}</data></array>`;
        }
        else valXml = `<string>${xmlEscape(String(v))}</string>`;
        return `<member><name>${k}</name><value>${valXml}</value></member>`;
      }).join('');
      return `<param><value><struct>${members}</struct></value></param>`;
    }
    return `<param><value><string>${xmlEscape(String(p))}</string></value></param>`;
  }).join('');

  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;

  const res = await fetch(WP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });

  const text = await res.text();

  // Check for fault
  if (text.includes('<fault>')) {
    const faultMatch = text.match(/<string>(.+?)<\/string>/);
    throw new Error(faultMatch ? faultMatch[1] : 'XML-RPC fault');
  }

  // Extract string/int response
  const strMatch = text.match(/<string>(.+?)<\/string>/);
  const intMatch = text.match(/<int>(\d+)<\/int>/);
  return strMatch ? strMatch[1] : intMatch ? parseInt(intMatch[1]) : text;
}

// ── Main ──
const [,, username, password, ...flags] = process.argv;
const isDraft = flags.includes('--draft');

if (!username || !password) {
  console.error('Usage: node scripts/ship-blogs.mjs <wp-username> <wp-password> [--draft]');
  process.exit(1);
}

console.log(`\n🦖 Shipping ${POSTS.length} blog posts to kodyw.com`);
console.log(`   Mode: ${isDraft ? 'DRAFT' : 'PUBLISH'}`);
console.log(`   User: ${username}\n`);

const results = [];

for (const post of POSTS) {
  process.stdout.write(`📝 ${post.title.slice(0, 50)}... `);

  try {
    // Fetch markdown from GitHub
    const res = await fetch(`${GITHUB_RAW}/${post.file}`);
    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
    const md = await res.text();

    // Convert to HTML
    const html = md2html(md);

    // Publish via XML-RPC (metaWeblog.newPost)
    // params: blogId, username, password, content, publish
    const postId = await xmlRpcCall('metaWeblog.newPost', [
      0, // blog ID (0 = default)
      username,
      password,
      {
        title: post.title,
        description: html,
        wp_slug: post.slug,
        categories: post.categories,
        mt_keywords: post.tags.join(', '),
        post_status: isDraft ? 'draft' : 'publish',
      },
      !isDraft, // publish boolean
    ]);

    const url = `https://kodyw.com/${post.slug}/`;
    results.push({ title: post.title, status: 'success', postId, url });
    console.log(`✅ ${isDraft ? 'Draft' : 'Published'} (ID: ${postId})`);
  } catch (err) {
    results.push({ title: post.title, status: 'error', error: err.message });
    console.log(`❌ ${err.message}`);
  }
}

// ── Generate report ──
console.log('\n═══════════════════════════════════════');
console.log('📊 SHIP REPORT');
console.log('═══════════════════════════════════════\n');

const success = results.filter(r => r.status === 'success');
const failed = results.filter(r => r.status === 'error');

console.log(`✅ Published: ${success.length}/${POSTS.length}`);
if (failed.length) console.log(`❌ Failed: ${failed.length}`);
console.log('');

for (const r of results) {
  if (r.status === 'success') {
    console.log(`  ✅ ${r.title}`);
    console.log(`     ${r.url}`);
  } else {
    console.log(`  ❌ ${r.title}: ${r.error}`);
  }
}

// Write HTML report
const reportHtml = `<!DOCTYPE html>
<html><head><title>Ship Report</title>
<style>body{background:#0a0e14;color:#e0e6ed;font-family:system-ui;padding:40px;max-width:700px;margin:0 auto}
h1{color:#00d4aa}a{color:#4fc3f7}.ok{color:#66bb6a}.err{color:#ef5350}.card{background:#12171f;border:1px solid #2a3545;border-radius:12px;padding:16px;margin:12px 0}</style>
</head><body>
<h1>🦖 Ship Report — ${new Date().toISOString().split('T')[0]}</h1>
<p>${success.length}/${POSTS.length} posts ${isDraft ? 'drafted' : 'published'} to kodyw.com</p>
${results.map(r => `
<div class="card">
  <strong class="${r.status === 'success' ? 'ok' : 'err'}">${r.status === 'success' ? '✅' : '❌'} ${r.title}</strong><br>
  ${r.status === 'success' ? `<a href="${r.url}" target="_blank">${r.url}</a><br>Post ID: ${r.postId}` : `Error: ${r.error}`}
</div>`).join('')}
<p style="color:#6b7a8d;margin-top:24px;">
  Staging: <a href="https://kody-w.github.io">kody-w.github.io</a><br>
  Production: <a href="https://kodyw.com">kodyw.com</a><br>
  Pipeline: Digital Twin → GitHub Pages (staging) → WordPress (production)
</p>
</body></html>`;

import { writeFileSync } from 'fs';
writeFileSync('/tmp/ship-report.html', reportHtml);
console.log(`\n📄 Report: /tmp/ship-report.html`);
console.log('   open /tmp/ship-report.html\n');
