import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

// ---- Fixture: a workspace with frontend, backend and a shared library repo ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-'));
const w = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

w('ws/workspace.yaml', `
name: demo
repos:
  frontend: { path: ../frontend, role: iOS app, stack: [ios], checks: { ok: [node, -e, "console.log('all good')"], bad: [node, -e, "process.exit(3)"] } }
  backend:  { path: ../backend,  role: API, stack: [node] }
  billing:  { path: ../billing,  role: invoicing service, stack: [node] }
  sharedlib: { path: ../sharedlib, role: shared upload package, stack: [ios] }
knowledge:
  agents: AGENTS.md
  catalog: knowledge/catalog.yaml
  experts: knowledge/experts
  decisions: knowledge/decisions
  learnings: knowledge/learnings
  plans: plans
default_profile: owner
profiles:
  owner: { repos: "*" }
  freelancer: { repos: [frontend, sharedlib], write_knowledge: false }
  contractor: { repos: [frontend], contracts: [backend, sharedlib], write_knowledge: false }
`);
w('ws/AGENTS.md', '# Rules\nContract first.');
w('ws/knowledge/catalog.yaml', `
services:
  - { name: upload-kit, description: document upload and preview, repo: sharedlib, reusable: true, package: "SPM upload-kit >= 1.0", capabilities: [upload, pdf], consumers: [{ repo: frontend, via: AttachmentManager }] }
  - { name: profile-api, description: profile CRUD, repo: backend, contract: { repo: backend, path: contracts/openapi.yaml }, consumers: [frontend, { repo: billing, via: BillingSync }], notes: internal DB is single-region }
  - { name: billing-api, description: invoices, repo: billing, consumers: [backend] }
`);
w('ws/knowledge/experts/ios.md', '# iOS pack\nUse async/await.');
w('ws/knowledge/decisions/0001-auth.md', '# Auth\nAuthorize by the signed-in user token, never by an ID in the URL.');
w('frontend/Sources/App/Upload.swift', 'func uploadDocument() { /* uses upload-kit */ }');
w('frontend/.env', 'API_KEY=AKIAABCDEFGHIJKLMNOP');
w('backend/routes/profiles.js', 'export function getProfile(id) { return db.get(id) }\nconst key = "AKIAABCDEFGHIJKLMNOP";');
w('backend/contracts/openapi.yaml', 'openapi: 3.1.0\npaths:\n  /api/profiles: {}');
w('sharedlib/Sources/UploadKit/Upload.swift', 'public func uploadDocument(data: Data) {}');
w('billing/src/invoice.js', 'export const invoice = 1;');
w('outside/secret.txt', 'top secret');

async function connect(profile, cfgFile = path.join(root, 'ws/workspace.yaml')) {
  const cfg = loadConfig(cfgFile, profile);
  const server = buildServer(cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError };
};

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('exposes the 15 tools', async () => {
  const c = await connect('owner');
  const { tools } = await c.listTools();
  assert.equal(tools.length, 15);
  assert.ok(tools.find((t) => t.name === 'search_code').annotations.readOnlyHint);
});

test('overview shows repos, expert packs and rules', async () => {
  const r = await call(await connect('owner'), 'workspace_overview');
  assert.match(r.text, /frontend: iOS app/);
  assert.match(r.text, /Expert packs: ios/);
  assert.match(r.text, /Contract first/);
});

test('find_reuse finds the reusable service and code', async () => {
  const r = await call(await connect('owner'), 'find_reuse', { need: 'document upload' });
  assert.match(r.text, /upload-kit \(sharedlib\) \[reusable\]/);
  assert.match(r.text, /use as: SPM upload-kit/);
});

test('get_service shows consumers (impact) and contract', async () => {
  const c = await connect('owner');
  const r = await call(c, 'get_service', { name: 'upload-kit' });
  assert.match(r.text, /frontend via AttachmentManager/);
  const k = await call(c, 'get_contract', { service: 'profile-api' });
  assert.match(k.text, /openapi: 3\.1\.0/);
});

test('search_code spans repos, returns snippets, redacts secrets, skips .env', async () => {
  const c = await connect('owner');
  const r = await call(c, 'search_code', { query: 'uploadDocument' });
  assert.match(r.text, /frontend\/Sources\/App\/Upload\.swift:1/);
  assert.match(r.text, /sharedlib\/Sources\/UploadKit\/Upload\.swift:1/);
  const s = await call(c, 'search_code', { query: 'AKIA' });
  assert.doesNotMatch(s.text, /AKIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(s.text, /\.env/);
});

test('read_file blocks path escape and secret files', async () => {
  const c = await connect('owner');
  assert.equal((await call(c, 'read_file', { repo: 'backend', path: '../outside/secret.txt' })).isError, true);
  assert.equal((await call(c, 'read_file', { repo: 'frontend', path: '.env' })).isError, true);
  const ok = await call(c, 'read_file', { repo: 'backend', path: 'routes/profiles.js', start_line: 1, end_line: 1 });
  assert.match(ok.text, /^1: export function getProfile/);
});

test('freelancer profile cannot see backend, its services, or write knowledge', async () => {
  const c = await connect('freelancer');
  const s = await call(c, 'search_code', { query: 'getProfile' });
  assert.equal(s.text, 'No matches.');
  assert.equal((await call(c, 'read_file', { repo: 'backend', path: 'routes/profiles.js' })).isError, true);
  assert.equal((await call(c, 'get_service', { name: 'profile-api' })).isError, true);
  assert.equal((await call(c, 'search_code', { query: 'x', repos: ['backend'] })).isError, true);
  assert.equal((await call(c, 'record_learning', { title: 'x x', problem: 'p p p', fix: 'f f f' })).isError, true);
  const ov = await call(c, 'workspace_overview');
  assert.doesNotMatch(ov.text, /backend/);
});

test('plans and learnings are written as new files, never overwritten', async () => {
  const c = await connect('owner');
  const p = await call(c, 'create_plan', { feature: 'Add lead export', goal: 'Export leads to CSV', steps: [{ repo: 'backend', change: 'Add endpoint' }, { repo: 'frontend', change: 'Add button' }] });
  assert.match(p.text, /plans\/\d{4}-\d{2}-\d{2}-add-lead-export\.md/);
  const again = await call(c, 'create_plan', { feature: 'Add lead export', goal: 'again', steps: [{ repo: 'backend', change: 'x x x' }] });
  assert.match(again.text, /add-lead-export-2\.md/);
  const l = await call(c, 'record_learning', { title: 'PDF upload lost', problem: 'Security-scoped URL released', fix: 'Copy to temp dir first', tags: ['ios'] });
  assert.match(l.text, /saved for review/);
  assert.equal((await call(c, 'create_plan', { feature: 'bad repo', goal: 'xx x', steps: [{ repo: 'nope', change: 'x x x' }] })).isError, true);
});

test('search_knowledge finds decisions', async () => {
  const r = await call(await connect('owner'), 'search_knowledge', { query: 'signed-in' });
  assert.match(r.text, /0001-auth\.md/);
});

test('run_check runs only declared commands and reports pass/fail', async () => {
  const c = await connect('owner');
  const ok = await call(c, 'run_check', { repo: 'frontend', check: 'ok' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /PASS[\s\S]*all good/);
  const bad = await call(c, 'run_check', { repo: 'frontend', check: 'bad' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /exit 3/);
  const undef = await call(c, 'run_check', { repo: 'frontend', check: 'rm -rf /' });
  assert.equal(undef.isError, true);
});

test('search works without ripgrep (JS fallback)', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.WORKSPACE_MCP_NO_RG='1';
    const { searchText } = await import(${JSON.stringify(new URL('../src/search.js', import.meta.url).href)});
    const r = await searchText([{ name: 'backend', path: ${JSON.stringify(path.join(root, 'backend'))} }], 'getprofile', {});
    console.log(JSON.stringify(r));
  `, '--input-type=module'], { env: { ...process.env, WORKSPACE_MCP_NO_RG: '1' } }).toString();
  const r = JSON.parse(out);
  assert.equal(r[0].file, 'routes/profiles.js');
});

test('workspace.yaml edits apply without restarting the server', async () => {
  const cfgPath = path.join(root, 'ws/workspace.yaml');
  const cfg = loadConfig(cfgPath, 'owner');
  const server = buildServer(cfg, { configPath: cfgPath, reload: () => loadConfig(cfgPath, 'owner') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(b);
  const before = await call(c, 'workspace_overview');
  assert.match(before.text, /frontend: iOS app/);
  const original = fs.readFileSync(cfgPath, 'utf8');
  fs.writeFileSync(cfgPath, original.replace('role: iOS app', 'role: SwiftUI card app'));
  fs.utimesSync(cfgPath, new Date(), new Date(Date.now() + 5000));
  const after = await call(c, 'workspace_overview');
  assert.match(after.text, /frontend: SwiftUI card app/);
  fs.writeFileSync(cfgPath, original);
});

test('hand-off: plan created in one tool is resumed and updated from another', async () => {
  const claude = await connect('owner'); // client name "test"
  const p = await call(claude, 'create_plan', { feature: 'Per-user auth', goal: 'Verify the user token', steps: [{ repo: 'backend', change: 'Verify ID token' }, { repo: 'frontend', change: 'Send ID token' }] });
  assert.match(p.text, /Branch for every repo: feature\/per-user-auth/);
  const id = /id: ([^)]+)\)/.exec(p.text)[1];
  await call(claude, 'update_plan', { id, note: 'Backend verifies token; stopped before iOS.', status: 'in-progress', steps_done: [1] });

  // A second, independent session (e.g. Antigravity) picks it up
  const cfg = loadConfig(path.join(root, 'ws/workspace.yaml'), 'owner');
  const server = buildServer(cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const ag = new Client({ name: 'antigravity', version: '1' });
  await ag.connect(b);
  const list = await call(ag, 'list_plans');
  assert.match(list.text, new RegExp(`${id} \\[in-progress\\] Per-user auth · branch feature/per-user-auth`));
  assert.match(list.text, /last: .*\[test\].*stopped before iOS/);
  const full = await call(ag, 'get_plan', { id: 'per-user auth' });
  assert.match(full.text, /- \[x\] 1\. backend: Verify ID token/);
  assert.match(full.text, /- \[ \] 2\. frontend: Send ID token/);
  await call(ag, 'update_plan', { id, note: 'iOS sends token.', steps_done: [2], status: 'done' });
  const after = await call(ag, 'get_plan', { id });
  assert.match(after.text, /Status: done/);
  assert.match(after.text, /\[antigravity\] \(status: done\) \(done: step 2\) iOS sends token\./);
  assert.doesNotMatch((await call(ag, 'list_plans')).text, /Per-user auth/); // done plans hidden by default
  assert.equal((await call(ag, 'update_plan', { id: 'nope-nothing', note: 'x x x' })).isError, true);
});

test('workspace_status shows branch and dirty files, flags branch mismatch', async () => {
  const { execFileSync: ex } = await import('node:child_process');
  for (const r of ['frontend', 'backend']) {
    const d = path.join(root, r);
    ex('git', ['init', '-q', '-b', 'main'], { cwd: d });
    ex('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  }
  ex('git', ['checkout', '-q', '-b', 'feature/per-user-auth'], { cwd: path.join(root, 'backend') });
  const c = await connect('owner');
  const r = await call(c, 'workspace_status', { plan: 'per-user-auth' });
  assert.match(r.text, /- backend: feature\/per-user-auth · \d+ uncommitted/);
  assert.match(r.text, /- frontend: main .*<- not on feature\/per-user-auth/);
  assert.match(r.text, /- sharedlib: \? /);
});

test('interface-only profile: sees dependency contracts and consumers, never code or hidden repos', async () => {
  const c = await connect('contractor');
  const svc = await call(c, 'get_service', { name: 'profile-api' });
  assert.equal(svc.isError, false);
  assert.match(svc.text, /interface only/);
  assert.match(svc.text, /- frontend/);
  assert.doesNotMatch(svc.text, /billing|BillingSync|single-region/);   // hidden repo and internal notes stay out
  assert.equal((await call(c, 'get_service', { name: 'billing-api' })).isError, true);
  assert.equal((await call(c, 'search_code', { query: 'getProfile' })).text, 'No matches.');
  assert.equal((await call(c, 'read_file', { repo: 'backend', path: 'routes/profiles.js' })).isError, true);
  const ov = await call(c, 'workspace_overview');
  assert.match(ov.text, /Interface-only dependencies \(contracts, no code\): backend, sharedlib/);
  assert.doesNotMatch(ov.text, /billing/);
  const reuse = await call(c, 'find_reuse', { need: 'document upload' });
  assert.match(reuse.text, /upload-kit .*\[interface only\]/);
  assert.doesNotMatch(reuse.text, /AttachmentManager/);                  // "via" details are internal
  const contract = await call(c, 'get_contract', { service: 'profile-api' });
  assert.equal(contract.isError, true);                                   // not published yet
  assert.match(contract.text, /export-profile/);
});

test('owner still sees full catalog entries, including hidden-to-others consumers', async () => {
  const c = await connect('owner');
  const svc = await call(c, 'get_service', { name: 'profile-api' });
  assert.match(svc.text, /billing via BillingSync/);
  assert.doesNotMatch(svc.text, /interface only/);
});

test('export-profile writes a scoped workspace: published contracts, no trace of other repos', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = path.join(root, 'export-contractor');
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/cli.js');
  execFileSync(process.execPath, [cli, 'export-profile', '--config', path.join(root, 'ws/workspace.yaml'), '--profile', 'contractor', '--out', out]);
  const files = fs.readdirSync(out, { recursive: true }).map(String);
  const all = files.filter((f) => fs.statSync(path.join(out, f)).isFile()).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /billing|BillingSync|single-region/);
  assert.match(fs.readFileSync(path.join(out, 'knowledge/contracts/profile-api.yaml'), 'utf8'), /\/api\/profiles/);
  // Contractor's machine: only frontend cloned next to the exported workspace.
  fs.cpSync(path.join(root, 'frontend'), path.join(root, 'repos/frontend'), { recursive: true });
  const c = await connect(undefined, path.join(out, 'workspace.yaml'));
  const contract = await call(c, 'get_contract', { service: 'profile-api' });
  assert.equal(contract.isError, false);
  assert.match(contract.text, /published contract for profile-api[\s\S]*\/api\/profiles/);
  const s = await call(c, 'search_code', { query: 'uploadDocument' });
  assert.match(s.text, /^frontend\//);
  assert.doesNotMatch(s.text, /sharedlib/);
});
