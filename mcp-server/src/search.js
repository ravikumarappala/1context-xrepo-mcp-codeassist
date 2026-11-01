// Fast text search: ripgrep when installed, a small JS walker otherwise. Returns capped snippets.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { isBlocked, redact } from './safety.js';

let rgAvailable = process.env.WORKSPACE_MCP_NO_RG === '1' ? false : undefined;
function hasRg() {
  if (rgAvailable === undefined) {
    try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); rgAvailable = true; } catch { rgAvailable = false; }
  }
  return rgAvailable;
}

// Lock files and generated bundles are noise that wastes tokens; they stay readable via read_file.
const NOISE = /(^|\/)([^/]+\.lock|package-lock\.json|Package\.resolved|[^/]+\.min\.js|[^/]+\.map)$/;
const EXCLUDES = ['*.lock', 'package-lock.json', 'Package.resolved', '*.min.js', '*.map', '.git', 'node_modules', '.terraform', 'Pods', 'DerivedData', 'build', 'dist', '.venv', 'venv', '__pycache__', '*.tfstate*', '.env*', '*.pem', '*.key', 'terraform.tfvars', 'Config-*.plist', 'GoogleService-Info.plist'];

/**
 * @param {{name:string,path:string}[]} roots
 * @returns {Promise<{repo:string,file:string,line:number,text:string}[]>}
 */
export async function searchText(roots, query, { glob, maxResults = 40, regex = false } = {}) {
  const out = [];
  for (const root of roots) {
    if (out.length >= maxResults) break;
    const hits = hasRg() ? await rgSearch(root.path, query, { glob, regex, max: maxResults - out.length })
      : jsSearch(root.path, query, { glob, regex, max: maxResults - out.length });
    for (const h of hits) out.push({ repo: root.name, ...h, text: redact(h.text).trim().slice(0, 240) });
  }
  return out.slice(0, maxResults);
}

function rgSearch(dir, query, { glob, regex, max }) {
  const args = ['--json', '--max-count', '5', '--max-filesize', '1M', '--max-columns', '300'];
  if (!regex) args.push('--fixed-strings');
  args.push('--ignore-case');
  for (const e of EXCLUDES) args.push('--glob', `!${e}`);
  if (glob) args.push('--glob', glob);
  args.push('--', query, '.');
  return new Promise((resolve) => {
    execFile('rg', args, { cwd: dir, maxBuffer: 20 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      const hits = [];
      for (const line of String(stdout || '').split('\n')) {
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type !== 'match') continue;
        const file = m.data.path.text.replace(/^\.\//, '');
        if (isBlocked(file) || NOISE.test(file)) continue;
        hits.push({ file, line: m.data.line_number, text: m.data.lines.text || '' });
        if (hits.length >= max) break;
      }
      resolve(hits);
    });
  });
}

function globToRe(glob) {
  const g = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`(^|/)${g}$`);
}

function jsSearch(dir, query, { glob, regex, max }) {
  const re = regex ? new RegExp(query, 'i') : null;
  const q = query.toLowerCase();
  const g = glob ? globToRe(glob) : null;
  const hits = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (hits.length >= max) return;
      const full = path.join(d, ent.name);
      const rel = path.relative(dir, full);
      if (isBlocked(rel)) continue;
      if (ent.isDirectory()) { walk(full); continue; }
      if (NOISE.test(rel)) continue;
      if (g && !g.test(rel)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 1024 * 1024) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      let perFile = 0;
      lines.forEach((t, i) => {
        if (hits.length >= max || perFile >= 5) return;
        if (re ? re.test(t) : t.toLowerCase().includes(q)) { hits.push({ file: rel, line: i + 1, text: t }); perFile++; }
      });
    }
  };
  walk(dir);
  return hits;
}
