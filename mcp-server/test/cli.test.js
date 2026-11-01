import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wscli-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(name, files) {
  const d = path.join(root, 'ws', 'repos', name);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
}

test('doctor passes on a valid workspace, flags tracked secrets, fails on bad catalog', () => {
  repo('app', { 'README.md': 'A demo app that shows countries and their details.', 'main.js': 'console.log(1)', '.env': 'X=1', '.env.example': 'X=' });
  fs.writeFileSync(path.join(root, 'ws/workspace.yaml'), 'name: t\nrepos:\n  app: { path: repos/app, role: demo app, stack: [node] }\nknowledge: { catalog: catalog.yaml }\n');
  fs.writeFileSync(path.join(root, 'ws/catalog.yaml'), 'services:\n  - { name: app, repo: app, reusable: true }\n');
  const ok = spawnSync(process.execPath, [CLI, 'doctor', '--config', path.join(root, 'ws/workspace.yaml')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /server starts over stdio, 15 tools/);
  assert.match(ok.stdout, /secret-looking files tracked in git: \.env\b/);
  assert.doesNotMatch(ok.stdout, /\.env\.example/);

  fs.writeFileSync(path.join(root, 'ws/catalog.yaml'), 'services:\n  - { name: ghost, repo: nope }\n');
  const bad = spawnSync(process.execPath, [CLI, 'doctor', '--config', path.join(root, 'ws/workspace.yaml')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /points to unknown repo "nope"/);
});

test('connect prints Claude Code, Cursor/Antigravity and VS Code configs', () => {
  const r = spawnSync(process.execPath, [CLI, 'connect', '--config', path.join(root, 'ws/workspace.yaml')], { encoding: 'utf8' });
  assert.match(r.stdout, /claude mcp add workspace-t --scope user -- /);
  assert.match(r.stdout, /"mcpServers"/);
  assert.match(r.stdout, /"servers"/);
});

test('init --scan/--local references existing clones in place (nothing copied)', () => {
  const g = path.join(root, 'repos-root');
  const mk = (rel, files) => { const d = path.join(g, rel); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } execFileSync('git', ['init', '-q'], { cwd: d }); };
  mk('acme/frontend/web-portal', { 'App.xcodeproj/project.pbxproj': '', 'README.md': 'The customer web portal for Acme Retail.' });
  mk('acme/backend/orders-api', { 'package.json': '{"scripts":{"test":"node --test"}}' });
  mk('shared/auth-lambda', { 'requirements.txt': 'boto3', 'tests/test_x.py': '' });
  const ws = path.join(root, 'work/acme');
  const r = spawnSync(process.execPath, [CLI, 'init', '--dir', ws, '--name', 'acme', '--scan', path.join(g, 'acme'), '--local', path.join(g, 'shared/auth-lambda')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Using 3 existing repo\(s\) in place/);
  const yaml = fs.readFileSync(path.join(ws, 'workspace.yaml'), 'utf8');
  assert.match(yaml, new RegExp(`path: ${path.join(g, 'acme/frontend/web-portal').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(yaml, /-scheme\n\s+- App/);
  assert.equal(fs.existsSync(path.join(ws, 'repos')), false);
  const d = spawnSync(process.execPath, [CLI, 'doctor', '--config', path.join(ws, 'workspace.yaml')], { encoding: 'utf8' });
  assert.equal(d.status, 0, d.stdout);
  const bad = spawnSync(process.execPath, [CLI, 'init', '--dir', ws, '--name', 'x', '--local', path.join(g, 'acme')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Not a git repo/);
});

test('init role detection skips shell commands and never cuts mid-word', () => {
  const g = path.join(root, 'readme-repos');
  const d = path.join(g, 'scan');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), '# Deploy\ngcloud beta run services update image-resizer \\\n  --region us-central1\n```bash\nnpm run deploy-everything-now\n```\nPython service that extracts product images, resizes them and stores them in object storage for later lookup by the portal. Second sentence.\n');
  fs.writeFileSync(path.join(d, 'requirements.txt'), 'flask');
  execFileSync('git', ['init', '-q'], { cwd: d });
  const ws = path.join(root, 'work/readme');
  const r = spawnSync(process.execPath, [CLI, 'init', '--dir', ws, '--name', 'r', '--local', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const yaml = fs.readFileSync(path.join(ws, 'workspace.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /gcloud/);
  assert.match(yaml, /role: Python service that extracts product images/);
  assert.doesNotMatch(yaml, /Second sentence/);
});

test('setup-tools writes Antigravity config + rules for both tools, idempotent, removable', () => {
  const g = path.join(root, 'st');
  const mk = (name, files) => { const d = path.join(g, name); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
  const app = mk('app', { 'Package.swift': '', 'AGENTS.md': '# My own rules\nKeep this.\n' });
  const kit = mk('kit', { 'Package.swift': '' });
  const ws = path.join(root, 'work/st');
  fs.mkdirSync(path.join(ws, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `name: st\nrepos:\n  app: { path: ${app}, role: iOS app, stack: [ios] }\n  kit: { path: ${kit}, role: shared kit, stack: [ios] }\nknowledge: { catalog: knowledge/catalog.yaml }\n`);
  fs.writeFileSync(path.join(ws, 'knowledge/catalog.yaml'), 'services:\n  - { name: Kit, repo: kit, reusable: true, consumers: [{ repo: app }] }\n');
  // No claude CLI on PATH and a throwaway HOME: never touch the real user config in tests.
  const env = { ...process.env, PATH: '/usr/bin:/bin', HOME: path.join(root, 'fakehome') };
  const run = (...a) => spawnSync(process.execPath, [CLI, 'setup-tools', '--config', path.join(ws, 'workspace.yaml'), ...a], { encoding: 'utf8', env });
  const r1 = run();
  assert.equal(r1.status, 0, r1.stderr);
  const ag = JSON.parse(fs.readFileSync(path.join(app, '.agents/mcp_config.json'), 'utf8'));
  assert.equal(ag.mcpServers['workspace-st'].command, process.execPath);
  assert.deepEqual(ag.mcpServers['workspace-st'].args.slice(1), ['--config', path.join(ws, 'workspace.yaml')]);
  const agents = fs.readFileSync(path.join(app, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# My own rules\nKeep this\./);
  assert.match(agents, /This repo: \*\*app\*\* - iOS app/);
  assert.match(agents, /Depends on: Kit \(kit\)/);
  assert.match(fs.readFileSync(path.join(kit, 'CLAUDE.md'), 'utf8'), /Used by: app/);
  assert.match(fs.readFileSync(path.join(app, '.git/info/exclude'), 'utf8'), /\.agents\/mcp_config\.json/);
  assert.match(r1.stdout, /claude mcp add workspace-st --scope local/);
  const r2 = run(); // idempotent
  assert.equal(r2.status, 0);
  assert.equal((fs.readFileSync(path.join(app, 'AGENTS.md'), 'utf8').match(/workspace-mcp:start/g) || []).length, 1);
  const r3 = run('--remove');
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(fs.readFileSync(path.join(app, 'AGENTS.md'), 'utf8').trim(), '# My own rules\nKeep this.');
  assert.equal(fs.existsSync(path.join(kit, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(app, '.agents/mcp_config.json')), false);
});

test('claude launcher attaches every other workspace repo with --add-dir', () => {
  const ws = path.join(root, 'work/st');
  const r = spawnSync(process.execPath, [CLI, 'claude', '--config', path.join(ws, 'workspace.yaml'), '--repo', 'app', '--print-only'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^claude --add-dir ${path.join(root, 'st/kit')}`));
  assert.doesNotMatch(r.stdout, /st\/app/);
});
