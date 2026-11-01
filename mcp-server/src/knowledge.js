// Catalog, expert packs, decisions, learnings, plans. Plain files in git: readable by humans and every tool.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { slug, redact } from './safety.js';

const consumerRepo = (c) => (typeof c === 'string' ? c : c.repo);
// Fields an interface-only user may see. No paths, notes or internal "via" details.
const INTERFACE_FIELDS = ['name', 'description', 'repo', 'reusable', 'package', 'capabilities', 'stack', 'contract'];

/**
 * Catalog as this profile may see it:
 *  - services in accessible repos: full entry
 *  - services in interface-only repos: name, description, package, contract (marked contractOnly)
 *  - services anywhere else: not listed at all
 * Consumers in repos the profile cannot see are dropped, so hidden repo names never appear.
 */
export function loadCatalog(cfg) {
  if (!cfg.knowledge.catalog || !fs.existsSync(cfg.knowledge.catalog)) return [];
  const raw = YAML.parse(fs.readFileSync(cfg.knowledge.catalog, 'utf8')) || {};
  const code = new Set(cfg.repos.map((r) => r.name));
  const iface = new Set(cfg.contractOnly || []);
  const visible = (n) => code.has(n) || iface.has(n);
  return (raw.services || []).filter((s) => visible(s.repo)).map((s) => {
    const consumers = (s.consumers || []).filter((c) => visible(consumerRepo(c)));
    if (code.has(s.repo)) return { ...s, consumers };
    const out = Object.fromEntries(INTERFACE_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
    return { ...out, consumers: consumers.map(consumerRepo), contractOnly: true };
  });
}

/** Published copy of a service's contract in the workspace (knowledge/contracts/<service>.*), if any. */
export function publishedContract(cfg, service) {
  const dir = cfg.knowledge.contracts;
  if (!dir || !fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.replace(/\.[^.]+$/, '').toLowerCase() === service.toLowerCase());
  return f ? path.join(dir, f) : null;
}

export function scoreService(s, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [s.name, s.description, s.repo, ...(s.products || []), ...(s.stack || []), ...(s.capabilities || []), s.cloud].join(' ').toLowerCase();
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
}

export function listMarkdown(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

export function readCapped(file, maxBytes) {
  const buf = fs.readFileSync(file);
  const text = buf.subarray(0, maxBytes).toString('utf8');
  return redact(text) + (buf.length > maxBytes ? `\n\n[truncated: ${buf.length - maxBytes} more bytes; ask for a narrower section]` : '');
}

export function writeNew(dir, base, content) {
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.md`; let i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${i++}.md`; // never overwrite
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { flag: 'wx' });
  return file;
}

// Local time (not UTC), so plan and learning dates match the user's day.
const pad = (n) => String(n).padStart(2, '0');
export function today(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export const PLAN_STATUSES = ['draft', 'in-progress', 'blocked', 'done', 'abandoned'];

export function planMarkdown({ feature, goal, steps, profile, branch, by }) {
  const byRepo = steps.map((s, i) => `### ${i + 1}. ${s.repo}\n${s.change}\n${s.checks ? `\nChecks: ${s.checks}` : ''}`).join('\n\n');
  const checklist = steps.map((s, i) => `- [ ] ${i + 1}. ${s.repo}: ${s.change.split('\n')[0].slice(0, 100)}`).join('\n');
  return `# Plan: ${feature}\n\nDate: ${today()} · Author profile: ${profile} · Status: draft\nBranch: ${branch}\n\n## Goal\n${goal}\n\n## Changes by repo (in order)\n${byRepo}\n\n## Checklist\n${checklist}\n\n## Release order\nShared package → backend (backward compatible) → clients. Remove old fields only after old clients are gone.\n\n## Done when\n- [ ] Each repo's checks pass\n- [ ] API contract and client models updated together\n- [ ] PRs linked to this plan\n\n## Progress log\n- ${now()} [${by}] Plan created.\n`;
}

export const now = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const planStatus = (md) => (/Status:\s*([a-z-]+)/.exec(md) || [])[1] || 'unknown';
export const planBranch = (md) => (/^Branch:\s*(.+)$/m.exec(md) || [])[1]?.trim() || null;
export const planTitle = (md) => (/^# Plan:\s*(.+)$/m.exec(md) || [])[1]?.trim() || '(untitled)';
export const lastLog = (md) => {
  const sec = md.split('## Progress log')[1] || '';
  const lines = sec.split('\n').filter((l) => l.startsWith('- '));
  return lines[lines.length - 1]?.slice(2) || '';
};

/** Apply a progress update: append a log line, optionally change status and tick checklist items. */
export function applyPlanUpdate(md, { note, status, stepsDone = [], by }) {
  let out = md;
  if (status) out = out.replace(/Status:\s*[a-z-]+/, `Status: ${status}`);
  for (const n of stepsDone) out = out.replace(new RegExp(`^- \\[ \\] ${n}\\. `, 'm'), `- [x] ${n}. `);
  if (!out.includes('## Progress log')) out += '\n## Progress log\n';
  const entry = `- ${now()} [${by}]${status ? ` (status: ${status})` : ''}${stepsDone.length ? ` (done: step ${stepsDone.join(', ')})` : ''} ${note.replace(/\n+/g, ' ').trim()}`;
  return `${out.replace(/\s*$/, '')}\n${entry}\n`;
}

export function learningMarkdown({ title, problem, fix, tags, repos, profile }) {
  return `# ${title}\n\nDate: ${today()} · Profile: ${profile} · Status: proposed (needs owner review)\nTags: ${(tags || []).join(', ')}\nRepos: ${(repos || []).join(', ')}\n\n## Problem\n${problem}\n\n## Fix / rule\n${fix}\n`;
}

export { slug };
