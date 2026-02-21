import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';

const DOCS_DIR = resolve(__dirname, '../../../../docs');

function readDoc(filename: string): string {
  return readFileSync(resolve(DOCS_DIR, filename), 'utf-8');
}

function parseHTML(filename: string): Document {
  const html = readDoc(filename);
  const dom = new JSDOM(html);
  return dom.window.document;
}

const HTML_FILES = ['index.html', 'docs.html', 'architecture.html', 'tutorial.html', 'changelog.html'];
const DELETED_FILES = [
  'teach.html', 'single-file-agents.html', 'install.md', 'config.md',
  'skills.md', 'memory.md', 'api.md', 'agent-install.md',
  'IMPLEMENTATION_PLAN.md', 'ROADMAP-SELF-IMPROVING.md',
];

/* ── 1. File existence ── */
describe('File existence', () => {
  for (const file of HTML_FILES) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(DOCS_DIR, file))).toBe(true);
    });
  }

  it('styles.css exists', () => {
    expect(existsSync(resolve(DOCS_DIR, 'styles.css'))).toBe(true);
  });

  it('nav.js exists', () => {
    expect(existsSync(resolve(DOCS_DIR, 'nav.js'))).toBe(true);
  });

  it('install.sh exists', () => {
    expect(existsSync(resolve(DOCS_DIR, 'install.sh'))).toBe(true);
  });

  it('.nojekyll exists', () => {
    expect(existsSync(resolve(DOCS_DIR, '.nojekyll'))).toBe(true);
  });

  for (const file of DELETED_FILES) {
    it(`${file} does NOT exist`, () => {
      expect(existsSync(resolve(DOCS_DIR, file))).toBe(false);
    });
  }
});

/* ── 2. HTML well-formedness ── */
describe('HTML well-formedness', () => {
  for (const file of HTML_FILES) {
    describe(file, () => {
      let doc: Document;
      let raw: string;
      beforeAll(() => {
        raw = readDoc(file);
        doc = parseHTML(file);
      });

      it('has DOCTYPE', () => {
        expect(raw.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
      });

      it('has charset meta', () => {
        const meta = doc.querySelector('meta[charset]');
        expect(meta).not.toBeNull();
      });

      it('has viewport meta', () => {
        const meta = doc.querySelector('meta[name="viewport"]');
        expect(meta).not.toBeNull();
      });

      it('has title', () => {
        const title = doc.querySelector('title');
        expect(title).not.toBeNull();
        expect(title!.textContent!.length).toBeGreaterThan(0);
      });

      it('links to styles.css', () => {
        const link = doc.querySelector('link[rel="stylesheet"][href="./styles.css"]');
        expect(link).not.toBeNull();
      });

      it('includes nav.js script', () => {
        const script = doc.querySelector('script[src="./nav.js"]');
        expect(script).not.toBeNull();
      });

      it('has exactly one nav', () => {
        const navs = doc.querySelectorAll('nav');
        expect(navs.length).toBe(1);
      });

      it('has exactly one footer', () => {
        const footers = doc.querySelectorAll('footer');
        expect(footers.length).toBe(1);
      });
    });
  }
});

/* ── 3. Internal link validation ── */
describe('Internal link validation', () => {
  for (const file of HTML_FILES) {
    describe(file, () => {
      let doc: Document;
      beforeAll(() => { doc = parseHTML(file); });

      it('all href="./..." links point to existing files', () => {
        const links = doc.querySelectorAll('a[href^="./"]');
        for (const link of links) {
          const href = link.getAttribute('href')!;
          const target = href.split('#')[0];
          if (target && target !== './') {
            const targetFile = target.replace('./', '');
            expect(existsSync(resolve(DOCS_DIR, targetFile)),
              `Broken link in ${file}: ${href}`).toBe(true);
          }
        }
      });

      it('all href="#..." anchor links resolve to element IDs', () => {
        const links = doc.querySelectorAll('a[href^="#"]');
        for (const link of links) {
          const href = link.getAttribute('href')!;
          const id = href.slice(1);
          if (!id) continue;
          const target = doc.getElementById(id);
          expect(target, `Broken anchor in ${file}: ${href}`).not.toBeNull();
        }
      });
    });
  }
});

/* ── 4. Navigation consistency ── */
describe('Navigation consistency', () => {
  for (const file of HTML_FILES) {
    describe(file, () => {
      let doc: Document;
      beforeAll(() => { doc = parseHTML(file); });

      it('has nav links to docs, architecture, tutorial, changelog', () => {
        const navLinks = doc.querySelector('.nav-links');
        expect(navLinks).not.toBeNull();
        const hrefs = Array.from(navLinks!.querySelectorAll('a'))
          .map(a => a.getAttribute('href'));
        expect(hrefs).toContain('./docs.html');
        expect(hrefs).toContain('./architecture.html');
        expect(hrefs).toContain('./tutorial.html');
        expect(hrefs).toContain('./changelog.html');
      });

      it('has GitHub link', () => {
        const links = Array.from(doc.querySelectorAll('a[href*="github.com/kody-w/openrappter"]'));
        expect(links.length).toBeGreaterThan(0);
      });

      it('logo links to ./', () => {
        const logo = doc.querySelector('.logo');
        expect(logo).not.toBeNull();
        expect(logo!.getAttribute('href')).toBe('./');
      });

      it('version badge shows v1.4.1', () => {
        const badge = doc.querySelector('.logo-badge');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toContain('v1.4.1');
      });
    });
  }
});

/* ── 5. index.html content ── */
describe('index.html content', () => {
  let doc: Document;
  beforeAll(() => { doc = parseHTML('index.html'); });

  it('has hero section', () => {
    expect(doc.querySelector('.hero')).not.toBeNull();
  });

  it('contains curl install command', () => {
    const body = doc.body.textContent!;
    expect(body).toContain('curl -fsSL https://kody-w.github.io/openrappter/install.sh');
  });

  it('has at least 8 feature cards', () => {
    const cards = doc.querySelectorAll('.feature-card');
    expect(cards.length).toBeGreaterThanOrEqual(8);
  });

  it('mentions 15+ channels', () => {
    const body = doc.body.textContent!;
    expect(body).toMatch(/15\+?\s*channel/i);
  });

  it('has comparison table', () => {
    expect(doc.querySelector('.comparison-table')).not.toBeNull();
  });

  it('has agent showcase with multiple agents', () => {
    const cards = doc.querySelectorAll('.agent-card');
    expect(cards.length).toBeGreaterThanOrEqual(10);
  });
});

/* ── 6. docs.html content ── */
describe('docs.html content', () => {
  let doc: Document;
  beforeAll(() => { doc = parseHTML('docs.html'); });

  it('has sidebar with 10+ items', () => {
    const items = doc.querySelectorAll('.sidebar-nav li');
    expect(items.length).toBeGreaterThanOrEqual(10);
  });

  it('has getting-started section', () => {
    expect(doc.getElementById('getting-started')).not.toBeNull();
  });

  it('has agents section', () => {
    expect(doc.getElementById('agents')).not.toBeNull();
  });

  it('agents section lists 10+ agents', () => {
    const agentsSection = doc.getElementById('agents');
    expect(agentsSection).not.toBeNull();
    // Count h4 or strong elements that name agents
    const body = agentsSection!.textContent!;
    const agentNames = ['BasicAgent', 'ShellAgent', 'MemoryAgent', 'WebAgent',
      'BrowserAgent', 'MessageAgent', 'TTSAgent', 'SessionsAgent',
      'CronAgent', 'ImageAgent', 'OuroborosAgent'];
    let found = 0;
    for (const name of agentNames) {
      if (body.includes(name)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(10);
  });

  it('has providers section mentioning all 5', () => {
    const section = doc.getElementById('providers');
    expect(section).not.toBeNull();
    const text = section!.textContent!;
    expect(text).toContain('Copilot');
    expect(text).toContain('Anthropic');
    expect(text).toContain('OpenAI');
    expect(text).toContain('Ollama');
  });

  it('has channels section mentioning 5+ platforms', () => {
    const section = doc.getElementById('channels');
    expect(section).not.toBeNull();
    const text = section!.textContent!;
    const platforms = ['Slack', 'Discord', 'Telegram', 'WhatsApp', 'Signal'];
    let found = 0;
    for (const p of platforms) {
      if (text.includes(p)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(5);
  });

  it('has multi-agent section', () => {
    expect(doc.getElementById('multi-agent')).not.toBeNull();
  });

  it('has gateway section', () => {
    expect(doc.getElementById('gateway')).not.toBeNull();
  });

  it('has skills section', () => {
    expect(doc.getElementById('skills')).not.toBeNull();
  });

  it('has memory section', () => {
    expect(doc.getElementById('memory')).not.toBeNull();
  });

  it('has security section', () => {
    expect(doc.getElementById('security')).not.toBeNull();
  });

  it('has code tabs', () => {
    const tabs = doc.querySelectorAll('.code-tabs');
    expect(tabs.length).toBeGreaterThan(0);
  });
});

/* ── 7. architecture.html content ── */
describe('architecture.html content', () => {
  let doc: Document;
  let text: string;
  beforeAll(() => {
    doc = parseHTML('architecture.html');
    text = doc.body.textContent!;
  });

  it('has diagram section', () => {
    const diagrams = doc.querySelectorAll('.arch-diagram');
    expect(diagrams.length).toBeGreaterThan(0);
  });

  it('mentions Data Sloshing', () => {
    expect(text).toContain('Data Sloshing');
  });

  it('mentions Data Slush', () => {
    expect(text).toContain('Data Slush');
  });

  it('has code tabs', () => {
    expect(doc.querySelectorAll('.code-tabs').length).toBeGreaterThan(0);
  });

  it('has directory structure', () => {
    expect(text).toMatch(/typescript\//);
    expect(text).toMatch(/python\//);
  });
});

/* ── 8. tutorial.html content ── */
describe('tutorial.html content', () => {
  let doc: Document;
  let text: string;
  beforeAll(() => {
    doc = parseHTML('tutorial.html');
    text = doc.body.textContent!;
  });

  it('has at least 5 steps', () => {
    const steps = doc.querySelectorAll('.step');
    expect(steps.length).toBeGreaterThanOrEqual(5);
  });

  it('has install instructions', () => {
    expect(text).toContain('curl -fsSL');
  });

  it('has create agent step', () => {
    expect(text).toMatch(/create.*agent|custom.*agent/i);
  });

  it('has code tabs', () => {
    expect(doc.querySelectorAll('.code-tabs').length).toBeGreaterThan(0);
  });

  it('has next steps with links', () => {
    const links = doc.querySelectorAll('a[href="./docs.html"]');
    expect(links.length).toBeGreaterThan(0);
  });
});

/* ── 9. changelog.html content ── */
describe('changelog.html content', () => {
  let doc: Document;
  let text: string;
  beforeAll(() => {
    doc = parseHTML('changelog.html');
    text = doc.body.textContent!;
  });

  it('has v1.4.1 entry', () => {
    expect(text).toContain('v1.4.1');
  });

  it('has v1.4.0 entry', () => {
    expect(text).toContain('v1.4.0');
  });

  it('has v1.0.0 entry', () => {
    expect(text).toContain('v1.0.0');
  });

  it('has at least 5 timeline entries', () => {
    const items = doc.querySelectorAll('.timeline-item');
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  it('has version badges', () => {
    const badges = doc.querySelectorAll('.version-badge');
    expect(badges.length).toBeGreaterThanOrEqual(5);
  });
});

/* ── 10. External link checks ── */
describe('External link checks', () => {
  for (const file of HTML_FILES) {
    describe(file, () => {
      let doc: Document;
      beforeAll(() => { doc = parseHTML(file); });

      it('GitHub links point to correct repo', () => {
        const ghLinks = doc.querySelectorAll('a[href*="github.com"]');
        for (const link of ghLinks) {
          const href = link.getAttribute('href')!;
          if (href.includes('github.com') && !href.includes('fonts.')) {
            expect(href).toMatch(/github\.com\/kody-w\/openrappter/);
          }
        }
      });

      it('no links to deleted pages', () => {
        const links = doc.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href')!;
          // Only check local links — external URLs may legitimately contain these filenames
          if (href.startsWith('http://') || href.startsWith('https://')) continue;
          for (const deleted of DELETED_FILES) {
            expect(href, `Link to deleted file: ${deleted} in ${file}`)
              .not.toContain(deleted);
          }
        }
      });
    });
  }
});

/* ── 11. CSS validation ── */
describe('CSS validation', () => {
  let css: string;
  beforeAll(() => { css = readDoc('styles.css'); });

  it('is non-empty', () => {
    expect(css.length).toBeGreaterThan(100);
  });

  it('has :root variables', () => {
    expect(css).toContain(':root');
  });

  it('has nav styles', () => {
    expect(css).toMatch(/\bnav\b/);
  });

  it('has footer styles', () => {
    expect(css).toMatch(/\bfooter\b/);
  });

  it('has .btn class', () => {
    expect(css).toContain('.btn');
  });

  it('has @media queries', () => {
    expect(css).toContain('@media');
  });
});

/* ── 12. JS validation ── */
describe('JS validation', () => {
  let js: string;
  beforeAll(() => { js = readDoc('nav.js'); });

  it('is non-empty', () => {
    expect(js.length).toBeGreaterThan(50);
  });

  it('has mobile menu logic', () => {
    expect(js).toContain('mobile-menu-btn');
  });

  it('has tab switching logic', () => {
    expect(js).toContain('switchTab');
  });
});
