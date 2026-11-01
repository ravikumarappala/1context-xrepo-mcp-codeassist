#!/usr/bin/env node
// Setup helper for workspace-mcp.
//   node src/cli.js init   --dir ~/work/acme --name acme --repos owner/repo1,owner/repo2 [--shallow] [--force]
//   node src/cli.js doctor --config ~/work/acme/workspace.yaml [--profile owner]
//   node src/cli.js connect --config ~/work/acme/workspace.yaml   (prints tool registration commands)
//   node src/cli.js export-profile --config ~/work/acme/workspace.yaml --profile contractor --out ~/share/contractor-ws
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SECRET_NAME } from './safety.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const TEMPLATE = path.join(PKG_ROOT, 'template');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);
const expand = (p) => (p ? path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())) : p);
const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

export const EXPECTED_TOOLS = ['workspace_overview', 'find_reuse', 'get_service', 'get_contract', 'search_code', 'read_file', 'get_expert_pack',
  'search_knowledge', 'create_plan', 'record_learning', 'run_check', 'list_plans', 'get_plan', 'update_plan', 'workspace_status'];

let failures = 0; let warnings = 0;
const PASS = (m) => console.log(`  PASS  ${m}`);
const WARN = (m) => { warnings++; console.log(`  WARN  ${m}`); };
const FAIL = (m) => { failures++; console.log(`  FAIL  ${m}`); };

// ---------------------------------------------------------------- detection
function detect(repoDir) {
  const exists = (p) => fs.existsSync(path.join(repoDir, p));
  const top = fs.readdirSync(repoDir);
  const stack = []; const checks = {};
  const xcode = top.find((f) => f.endsWith('.xcworkspace')) || top.find((f) => f.endsWith('.xcodeproj'));
  if (xcode) {
    // App repo: build with Xcode. Scheme usually equals the project name; adjust in workspace.yaml if not.
    stack.push('ios', 'swift');
    const kind = xcode.endsWith('.xcworkspace') ? '-workspace' : '-project';
    checks.build = ['xcodebuild', kind, xcode, '-scheme', xcode.replace(/\.(xcodeproj|xcworkspace)$/, ''), '-destination', 'generic/platform=iOS Simulator', '-quiet', 'build'];
  } else if (exists('Package.swift')) {
    // Library repo (e.g. a shared Swift package)
    stack.push('ios', 'swift');
    checks.build = ['swift', 'build'];
  }
  if (exists('package.json')) {
    stack.push('node');
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
      const t = pj.scripts?.test || '';
      if (t && !/no test specified/.test(t)) checks.test = ['npm', 'test'];
      if (pj.scripts?.lint) checks.lint = ['npm', 'run', 'lint'];
    } catch { /* ignore malformed package.json */ }
  }
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) {
    stack.push('python');
    if (exists('tests') || exists('test')) checks.test = ['python3', '-m', 'pytest', '-q'];
  }
  if (exists('pom.xml')) { stack.push('java'); checks.test = ['mvn', '-q', 'test']; }
  if (exists('build.gradle') || exists('build.gradle.kts')) { stack.push('java'); checks.test = [exists('gradlew') ? './gradlew' : 'gradle', 'test']; }
  if (top.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) { stack.push('dotnet'); checks.test = ['dotnet', 'test']; }
  const tfDir = top.some((f) => f.endsWith('.tf')) ? '.' : ['terraform', 'infra', 'iac'].find((d) => exists(d) && fs.readdirSync(path.join(repoDir, d)).some((f) => f.endsWith('.tf')));
  if (tfDir) { stack.push('terraform'); checks.tf_fmt = ['terraform', `-chdir=${tfDir}`, 'fmt', '-check', '-recursive']; }
  let role = '';
  for (const r of ['README.md', 'readme.md', 'README']) {
    if (exists(r)) {
      const lines = fs.readFileSync(path.join(repoDir, r), 'utf8').split('\n').map((l) => l.trim());
      // Prefer the first prose sentence; fall back to the first heading.
      // Skip code fences and shell commands (e.g. "gcloud run services update ... \").
      let inFence = false;
      const textLines = lines.filter((l) => { if (l.startsWith('```')) { inFence = !inFence; return false; } return !inFence; });
      const isCommand = (l) => /\\$/.test(l) || /^\$\s/.test(l) ||
        /^(gcloud|gsutil|aws|npm|npx|yarn|pnpm|pip3?|python3?|node|git|terraform|docker|kubectl|cd|curl|brew|export|swift|xcodebuild|make|sh|bash)\b/.test(l);
      const prose = textLines.find((l) => l.length > 25 && !/^(#|\*|-|\[|<|!|\||>|`|\d+\.)/.test(l) && !isCommand(l));
      const heading = textLines.find((l) => /^#\s/.test(l));
      const raw = (prose || (heading ? heading.replace(/^#+\s*/, '') : '')).replace(/\*\*|`/g, '');
      // Cut at the end of the first sentence, or at a word boundary, never mid-word.
      const sentence = raw.split(/(?<=\.)\s/)[0];
      role = sentence.length <= 140 ? sentence : `${sentence.slice(0, 140).replace(/\s+\S*$/, '')}...`;
      break;
    }
  }
  return { stack: [...new Set(stack)], checks, role: role || 'TODO: describe this repo' };
}

// ---------------------------------------------------------------- init
function cloneRepo(spec, dest, shallow) {
  const ghAuthed = has('gh') && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
  const depth = shallow ? ['--depth', '1'] : [];
  if (ghAuthed) execFileSync('gh', ['repo', 'clone', spec, dest, '--', ...depth], { stdio: 'inherit' });
  else execFileSync('git', ['clone', ...depth, `https://github.com/${spec}.git`, dest], { stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

const isRepo = (d) => fs.existsSync(path.join(d, '.git'));
// Git root that contains a folder (the folder itself for a normal repo; the monorepo root for a subfolder).
const gitTop = (d) => { try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: d, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

/** Find git repos inside a folder (up to 3 levels deep), without descending into a found repo. */
function scanRepos(dir, depth = 3) {
  if (isRepo(dir)) return [dir];
  if (depth === 0) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ['node_modules', 'Pods', 'build', 'dist', 'venv', '.venv'].includes(ent.name)) continue;
    out.push(...scanRepos(path.join(dir, ent.name), depth - 1));
  }
  return out;
}

function init() {
  const dir = expand(opt('dir'));
  const name = opt('name');
  const list = (n) => (opt(n) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const specs = list('repos');
  const scans = list('scan').map(expand);
  const locals = list('local').map(expand);
  if (!dir || !name || !(specs.length || scans.length || locals.length)) {
    console.error('Usage: init --dir <workspace dir> --name <name> with any of:\n' +
      '  --scan  <folder>[,<folder>]      use every git repo already cloned inside these folders\n' +
      '  --local <repo dir>[,<repo dir>]  use these already-cloned repos\n' +
      '  --repos owner/repo[,owner/repo]  clone from GitHub into <dir>/repos\n' +
      '  [--shallow] [--force]');
    process.exit(2);
  }
  for (const s of specs) if (!/^[\w.-]+\/[\w.-]+$/.test(s)) { console.error(`Bad repo "${s}" (use owner/repo)`); process.exit(2); }

  const repos = {};
  const add = (repoDir, pathValue) => {
    let repoName = path.basename(repoDir);
    if (repos[repoName]) repoName = `${path.basename(path.dirname(repoDir))}-${repoName}`; // same folder name in two places
    const d = detect(repoDir);
    repos[repoName] = { path: pathValue, role: d.role, stack: d.stack, checks: d.checks };
    console.log(`   ${repoName}: stack [${d.stack.join(', ') || 'unknown'}], checks [${Object.keys(d.checks).join(', ') || 'none'}]`);
  };

  // Existing clones: referenced in place by absolute path (nothing copied or moved).
  const existing = [];
  for (const s of scans) {
    if (!fs.existsSync(s)) { console.error(`Not found: ${s}`); process.exit(2); }
    existing.push(...scanRepos(s));
  }
  for (const l of locals) {
    if (!isRepo(l)) { console.error(`Not a git repo (no .git): ${l}`); process.exit(2); }
    existing.push(l);
  }
  if (existing.length) {
    console.log(`\n1) Using ${existing.length} existing repo(s) in place`);
    for (const r of [...new Set(existing.map((e) => path.resolve(e)))]) add(r, r);
  }

  if (specs.length) {
    const reposDir = path.join(dir, 'repos');
    fs.mkdirSync(reposDir, { recursive: true });
    console.log(`\n1) Cloning ${specs.length} repo(s) into ${reposDir}`);
    for (const spec of specs) {
      const repoName = spec.split('/')[1];
      const dest = path.join(reposDir, repoName);
      if (isRepo(dest)) console.log(`   ${repoName}: already cloned, skipping`);
      else cloneRepo(spec, dest, flag('shallow'));
      add(dest, `repos/${repoName}`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });

  console.log('\n2) Writing workspace files');
  const wsFile = path.join(dir, 'workspace.yaml');
  if (fs.existsSync(wsFile) && !flag('force')) {
    console.log('   workspace.yaml exists: keeping it (use --force to regenerate). New repos are NOT auto-added.');
  } else {
    const doc = {
      name,
      repos,
      knowledge: { agents: 'AGENTS.md', catalog: 'knowledge/catalog.yaml', experts: 'knowledge/experts', decisions: 'knowledge/decisions', learnings: 'knowledge/learnings', plans: 'plans' },
      default_profile: 'owner',
      profiles: { owner: { repos: '*' } },
      limits: { max_results: 40, max_file_bytes: 60000, check_timeout_sec: 600 },
    };
    fs.writeFileSync(wsFile, `# Generated by workspace-mcp init. Review roles, checks and add freelancer profiles.\n${YAML.stringify(doc)}`);
    console.log('   workspace.yaml');
  }
  const copyIfMissing = (rel) => {
    const src = path.join(TEMPLATE, rel); const dst = path.join(dir, rel);
    if (fs.existsSync(dst)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    console.log(`   ${rel}`);
  };
  copyIfMissing('AGENTS.md');
  copyIfMissing('knowledge/experts/_TEMPLATE.md');
  copyIfMissing('knowledge/experts/ios.md');
  copyIfMissing('knowledge/decisions/0001-contract-first-api.md');
  copyIfMissing('knowledge/learnings/README.md');
  copyIfMissing('plans/README.md');
  const catFile = path.join(dir, 'knowledge/catalog.yaml');
  if (!fs.existsSync(catFile)) {
    const services = Object.entries(repos).map(([n, r]) => ({ name: n, description: r.role, repo: n, products: [name], stack: r.stack, reusable: false, consumers: [] }));
    fs.writeFileSync(catFile, `# One entry per service/module. Mark shared ones reusable: true, add consumers and contracts.\n${YAML.stringify({ services })}`);
    console.log('   knowledge/catalog.yaml (one starter entry per repo; refine by hand)');
  }
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), 'repos/\n');

  console.log(`\nNext:\n  node ${path.join(PKG_ROOT, 'src/cli.js')} doctor --config ${wsFile}\n  node ${path.join(PKG_ROOT, 'src/cli.js')} connect --config ${wsFile}\n`);
}

// ---------------------------------------------------------------- doctor
async function doctor() {
  const cfgPath = expand(opt('config'));
  if (!cfgPath) { console.error('Usage: doctor --config <workspace.yaml> [--profile name]'); process.exit(2); }
  console.log('\nEnvironment');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? PASS(`node ${process.versions.node}`) : FAIL(`node ${process.versions.node} (need 20+)`);
  has('rg') ? PASS('ripgrep installed') : WARN('ripgrep not installed (slower search). macOS: brew install ripgrep');
  has('git') ? PASS('git installed') : FAIL('git missing');

  console.log('\nConfiguration');
  const { loadConfig } = await import('./config.js');
  let cfg;
  try { cfg = loadConfig(cfgPath, opt('profile')); PASS(`loaded ${cfgPath} (profile ${cfg.profile}, ${cfg.repos.length} repos)`); }
  catch (e) { FAIL(`config: ${e.message}`); return summary(); }

  console.log('\nRepos');
  for (const r of cfg.repos) {
    if (!fs.existsSync(r.path)) { FAIL(`${r.name}: path not found ${r.path}`); continue; }
    const top = gitTop(r.path);
    if (!top) WARN(`${r.name}: not inside a git checkout`);
    else PASS(`${r.name}: ${path.relative(cfg.root, r.path)}${fs.realpathSync(top) !== fs.realpathSync(r.path) ? ' (folder in a shared repo)' : ''}`);
    if (/TODO/.test(r.role)) WARN(`${r.name}: role is TODO (assistants rely on it)`);
    for (const [cname, c] of Object.entries(r.checks)) {
      if (!Array.isArray(c) || !c.length) FAIL(`${r.name}: check "${cname}" must be a list like [npm, test]`);
      else if (!c[0].startsWith('./') && !has(c[0])) WARN(`${r.name}: check "${cname}" needs "${c[0]}" on PATH`);
    }
    // Security: secret-looking files tracked in git are a leak whether or not AI tools are used.
    try {
      const tracked = execFileSync('git', ['ls-files'], { cwd: r.path, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter((f) => f && SECRET_NAME.test(f));
      if (tracked.length) WARN(`${r.name}: secret-looking files tracked in git: ${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? ' ...' : ''} (rotate + remove from history)`);
    } catch { /* not a git repo */ }
  }

  console.log('\nKnowledge');
  for (const [k, p] of Object.entries(cfg.knowledge)) {
    if (k === 'contracts' && !cfg.contractOnly.length) continue;
    if (!p) WARN(`${k}: not configured`); else if (!fs.existsSync(p)) WARN(`${k}: missing ${path.relative(cfg.root, p)}`); else PASS(`${k}: ${path.relative(cfg.root, p)}`);
  }
  if (cfg.knowledge.catalog && fs.existsSync(cfg.knowledge.catalog)) {
    const raw = YAML.parse(fs.readFileSync(cfg.knowledge.catalog, 'utf8')) || {};
    const rawWs = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
    // Interface-only repos (profile contracts:) are valid catalog targets even when not cloned here.
    const all = [...Object.keys(rawWs.repos || {}), ...Object.values(rawWs.profiles || {}).flatMap((p) => p.contracts || [])];
    for (const s of raw.services || []) {
      if (!all.includes(s.repo)) FAIL(`catalog: service "${s.name}" points to unknown repo "${s.repo}"`);
      if (s.contract && !all.includes(s.contract.repo)) FAIL(`catalog: "${s.name}" contract repo "${s.contract.repo}" unknown`);
    }
    const reusable = (raw.services || []).filter((s) => s.reusable).length;
    reusable ? PASS(`catalog: ${raw.services.length} services, ${reusable} reusable`) : WARN('catalog: no service marked reusable yet (find_reuse will be weak)');
  }

  console.log('\nMCP server');
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, 'index.js'), '--config', cfgPath, ...(opt('profile') ? ['--profile', opt('profile')] : [])], stderr: 'ignore' });
    const client = new Client({ name: 'doctor', version: '1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const missing = EXPECTED_TOOLS.filter((t) => !tools.find((x) => x.name === t));
    missing.length ? FAIL(`missing tools: ${missing.join(', ')}`) : PASS(`server starts over stdio, ${tools.length} tools`);
    const ov = await client.callTool({ name: 'workspace_overview', arguments: {} });
    ov.isError ? FAIL('workspace_overview failed') : PASS('workspace_overview ok');
    if (cfg.repos[0]) {
      const s = await client.callTool({ name: 'search_code', arguments: { query: 'the', repos: [cfg.repos[0].name] } });
      s.isError ? FAIL(`search_code failed: ${s.content[0].text}`) : PASS(`search_code ok on ${cfg.repos[0].name}`);
    }
    await client.close();
  } catch (e) { FAIL(`server: ${e.message}`); }
  return summary();
}

function summary() {
  console.log(`\nResult: ${failures ? 'FAIL' : 'OK'} (${failures} failed, ${warnings} warnings)\n`);
  process.exitCode = failures ? 1 : 0;
}

// ---------------------------------------------------------------- connect
function connect() {
  const cfgPath = expand(opt('config'));
  if (!cfgPath) { console.error('Usage: connect --config <workspace.yaml>'); process.exit(2); }
  const name = `workspace-${YAML.parse(fs.readFileSync(cfgPath, 'utf8')).name}`;
  const entry = path.join(HERE, 'index.js');
  const node = process.execPath;
  const json = { mcpServers: { [name]: { command: node, args: [entry, '--config', cfgPath] } } };
  console.log(`\nRecommended for Claude Code + Antigravity (only in this workspace's repos):\n  node ${path.join(HERE, 'cli.js')} setup-tools --config ${cfgPath}`);
  console.log(`\nManual alternatives:\n\nClaude Code, every folder on this Mac (not recommended if you also do client work):\n  claude mcp add ${name} --scope user -- ${node} ${entry} --config ${cfgPath}\n  claude mcp list        # should show ${name} ... Connected`);
  console.log(`\nCursor (~/.cursor/mcp.json), or Antigravity per repo (<repo>/.agents/mcp_config.json):\n${JSON.stringify(json, null, 2)}`);
  console.log(`\nVS Code / Copilot (.vscode/mcp.json):\n${JSON.stringify({ servers: { [name]: { type: 'stdio', command: node, args: [entry, '--config', cfgPath] } } }, null, 2)}`);
  console.log('\nThe absolute node path avoids "command not found" when apps launch without your shell PATH.\n');
}

// ---------------------------------------------------------------- setup-tools (Claude Code + Antigravity, per repo)
const MARK_START = '<!-- workspace-mcp:start (generated; edit AGENTS.md in the workspace instead) -->';
const MARK_END = '<!-- workspace-mcp:end -->';

function upsertBlock(file, block) {
  const body = `${MARK_START}\n${block.trim()}\n${MARK_END}`;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END}`);
  const next = re.test(cur) ? cur.replace(re, body) : `${cur ? `${cur.replace(/\s*$/, '')}\n\n` : ''}${body}\n`;
  if (next !== cur) fs.writeFileSync(file, next);
  return next !== cur;
}

function removeBlock(file) {
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`\\n*${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END}\\n?`);
  if (!re.test(cur)) return false;
  const next = cur.replace(re, '\n').replace(/^\s+$/, '');
  if (next.trim()) fs.writeFileSync(file, next.replace(/\n{3,}/g, '\n\n')); else fs.rmSync(file);
  return true;
}

function mergeJsonServer(file, name, entry) {
  let json = {};
  if (fs.existsSync(file)) {
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix or delete it first`); }
  }
  json.mcpServers = json.mcpServers || {};
  if (entry === null) delete json.mcpServers[name]; else json.mcpServers[name] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (entry === null && !Object.keys(json.mcpServers).length && Object.keys(json).length === 1) { if (fs.existsSync(file)) fs.rmSync(file); return; }
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function gitExclude(repoPath, patterns) {
  const top = gitTop(repoPath);
  if (!top) return;
  const gitDir = path.join(top, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
  // Patterns are relative to the git root, so prefix them when the repo is a folder inside a larger repo.
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(repoPath)).split(path.sep).join('/');
  if (rel) patterns = patterns.map((p) => `/${rel}/${p}`);
  const ex = path.join(gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const add = patterns.filter((p) => !cur.split('\n').includes(p));
  if (add.length) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}# workspace-mcp (local paths, not shared)\n${add.join('\n')}\n`);
}

function repoBlock(ws, repo, catalog) {
  const others = ws.repos.filter((r) => r.name !== repo.name);
  const usesMe = catalog.filter((s) => s.repo === repo.name).flatMap((s) => (s.consumers || []).map((c) => (typeof c === 'string' ? c : c.repo)));
  const iUse = catalog.filter((s) => (s.consumers || []).some((c) => (typeof c === 'string' ? c : c.repo) === repo.name)).map((s) => `${s.name} (${s.repo})`);
  const name = `workspace-${ws.name}`;
  return `
## ${ws.name} workspace (shared by Claude Code and Antigravity)
This repo: **${repo.name}** - ${repo.role}
Related repos: ${others.map((r) => r.name).join(', ')}
${iUse.length ? `Depends on: ${[...new Set(iUse)].join(', ')}\n` : ''}${usesMe.length ? `Used by: ${[...new Set(usesMe)].join(', ')} (changes here can break them; check get_service)\n` : ''}
Use the \`${name}\` MCP tools:
1. Start: \`list_plans\` to resume work begun in either tool; \`workspace_overview\` for rules.
2. Before coding: \`find_reuse\`, \`get_expert_pack\`, \`search_knowledge\`.
3. Multi-repo change: \`create_plan\` (one branch name for all repos), then \`workspace_status\` to check branches.
4. Before finishing: \`run_check\` per changed repo.
5. Before stopping or switching tools: \`update_plan\` with what changed, where you stopped, what is next.
`;
}

async function setupTools() {
  const cfgPath = expand(opt('config'));
  if (!cfgPath) { console.error('Usage: setup-tools --config <workspace.yaml> [--profile name] [--remove]'); process.exit(2); }
  const { loadConfig } = await import('./config.js');
  const ws = loadConfig(cfgPath, opt('profile'));
  const raw = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
  const name = `workspace-${raw.name}`;
  const remove = flag('remove');
  const entry = { command: process.execPath, args: [path.join(HERE, 'index.js'), '--config', cfgPath, ...(opt('profile') ? ['--profile', opt('profile')] : [])] };
  const catalog = ws.knowledge.catalog && fs.existsSync(ws.knowledge.catalog) ? (YAML.parse(fs.readFileSync(ws.knowledge.catalog, 'utf8'))?.services || []) : [];
  const claudeCli = has('claude');

  console.log(`\n${remove ? 'Removing' : 'Setting up'} ${name} for Claude Code + Antigravity in ${ws.repos.length} repos\n`);
  for (const r of ws.repos) {
    if (!fs.existsSync(r.path)) { console.log(`  SKIP  ${r.name}: path missing`); continue; }
    const done = [];
    // Antigravity: per-workspace MCP config
    mergeJsonServer(path.join(r.path, '.agents', 'mcp_config.json'), name, remove ? null : entry);
    done.push(remove ? 'antigravity config removed' : '.agents/mcp_config.json');
    // Claude Code: local scope (this folder, this Mac only; nothing written to the repo)
    if (claudeCli) {
      spawnSync('claude', ['mcp', 'remove', name, '--scope', 'local'], { cwd: r.path, stdio: 'ignore' });
      if (!remove) {
        const add = spawnSync('claude', ['mcp', 'add', name, '--scope', 'local', '--', entry.command, ...entry.args], { cwd: r.path, encoding: 'utf8' });
        done.push(add.status === 0 ? 'claude (local scope)' : `claude FAILED: ${(add.stderr || add.stdout).trim().split('\n')[0]}`);
      } else done.push('claude removed');
    } else done.push('claude CLI not found: run the printed command below');
    // Rules for both tools: AGENTS.md (Antigravity + others) and CLAUDE.md (Claude Code)
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(r.path, f);
      if (remove) { if (removeBlock(file)) done.push(`${f} block removed`); } else if (upsertBlock(file, repoBlock({ ...ws, name: raw.name }, r, catalog))) done.push(f);
    }
    if (!remove) gitExclude(r.path, ['.agents/mcp_config.json']);
    console.log(`  OK    ${r.name}: ${done.join(', ')}`);
  }

  if (!remove) {
    if (claudeCli) {
      const u = spawnSync('claude', ['mcp', 'get', name], { encoding: 'utf8', cwd: os.tmpdir() });
      if (u.status === 0 && /scope:\s*user/i.test(u.stdout)) console.log(`\n  NOTE  ${name} is also registered for ALL folders (user scope). Remove it so it only runs in these repos:\n        claude mcp remove ${name} --scope user`);
    } else {
      console.log(`\nClaude Code: run in each repo folder:\n  claude mcp add ${name} --scope local -- ${entry.command} ${entry.args.join(' ')}`);
    }
    const g = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    if (fs.existsSync(g) && /workspace-/.test(fs.readFileSync(g, 'utf8'))) console.log(`\n  NOTE  ${g} also lists a workspace server; remove it there so it doesn't run in every Antigravity project.`);
    console.log(`
Next:
  - Commit the AGENTS.md / CLAUDE.md changes in each repo (no local paths in them).
    .agents/mcp_config.json holds local paths and is excluded from git via .git/info/exclude.
  - Antigravity: create ONE Project with all ${ws.repos.length} repo folders, then Settings > Customizations >
    Installed MCP Servers > refresh. ${name} should appear.
  - Claude Code with all repos editable: node ${path.join(HERE, 'cli.js')} claude --config ${cfgPath} --repo <name>
`);
  }
}

// ---------------------------------------------------------------- claude launcher (all workspace repos editable)
async function launchClaude() {
  const cfgPath = expand(opt('config'));
  const repoName = opt('repo');
  if (!cfgPath || !repoName) { console.error('Usage: claude --config <workspace.yaml> --repo <repo name> [-- extra claude args]'); process.exit(2); }
  const { loadConfig } = await import('./config.js');
  const ws = loadConfig(cfgPath, opt('profile'));
  const main = ws.repos.find((r) => r.name === repoName);
  if (!main) { console.error(`Unknown repo "${repoName}". Repos: ${ws.repos.map((r) => r.name).join(', ')}`); process.exit(2); }
  const dd = args.indexOf('--');
  const extra = dd > -1 ? args.slice(dd + 1) : [];
  const addDirs = ws.repos.filter((r) => r.name !== repoName && fs.existsSync(r.path)).flatMap((r) => ['--add-dir', r.path]);
  const argv = [...addDirs, ...extra];
  if (flag('print-only')) { console.log(['claude', ...argv].join(' ')); return; }
  console.log(`Starting Claude Code in ${main.name} with ${addDirs.length / 2} related repos editable…`);
  const res = spawnSync('claude', argv, { cwd: main.path, stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } });
  process.exit(res.status ?? 0);
}

// ---------------------------------------------------------------- export-profile
// Owner-side: write a workspace for a limited user. Their repos with code, interface-only entries and
// published contracts for dependencies, and nothing at all about other repos.
function exportProfile() {
  const cfgPath = expand(opt('config')); const pname = opt('profile'); const out = expand(opt('out'));
  if (!cfgPath || !pname || !out) { console.error('Usage: export-profile --config <workspace.yaml> --profile <name> --out <dir> [--include-knowledge]'); process.exit(2); }
  const raw = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
  const prof = raw.profiles?.[pname];
  if (!prof) { console.error(`Unknown profile "${pname}"`); process.exit(2); }
  if (prof.repos === '*') { console.error('This profile already sees every repo; nothing to scope.'); process.exit(2); }
  if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`${out} is not empty`); process.exit(2); }
  const base = path.dirname(cfgPath); const abs = (p) => path.resolve(base, p);
  const code = new Set(prof.repos); const iface = new Set((prof.contracts || []).filter((n) => !code.has(n)));
  const visible = (n) => code.has(n) || iface.has(n);
  const cRepo = (c) => (typeof c === 'string' ? c : c.repo);

  const repos = Object.fromEntries(prof.repos.map((n) => { const { path: _p, ...rest } = raw.repos[n]; return [n, { path: `../repos/${n}`, ...rest }]; }));
  const ws = {
    name: raw.name, repos,
    knowledge: { agents: 'AGENTS.md', catalog: 'knowledge/catalog.yaml', experts: 'knowledge/experts', decisions: 'knowledge/decisions', learnings: 'knowledge/learnings', plans: 'plans', contracts: 'knowledge/contracts' },
    default_profile: pname,
    profiles: { [pname]: { ...prof, contracts: [...iface] } },
    limits: raw.limits,
  };
  fs.mkdirSync(path.join(out, 'knowledge/contracts'), { recursive: true });
  for (const d of ['knowledge/learnings', 'knowledge/decisions', 'plans']) fs.mkdirSync(path.join(out, d), { recursive: true });
  fs.writeFileSync(path.join(out, 'workspace.yaml'), `# Exported for profile "${pname}". Point repo paths at your local clones.\n${YAML.stringify(ws)}`);

  const cat = raw.knowledge?.catalog ? YAML.parse(fs.readFileSync(abs(raw.knowledge.catalog), 'utf8')) || {} : {};
  const keep = ['name', 'description', 'repo', 'reusable', 'package', 'capabilities', 'stack', 'contract'];
  const services = []; let published = 0;
  for (const s of cat.services || []) {
    if (!visible(s.repo)) continue;
    const consumers = (s.consumers || []).filter((c) => visible(cRepo(c)));
    const entry = code.has(s.repo) ? { ...s, consumers } : { ...Object.fromEntries(keep.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])), consumers: consumers.map(cRepo) };
    services.push(entry);
    if (s.contract && !code.has(s.contract.repo) && raw.repos[s.contract.repo]) {
      const src = path.resolve(abs(raw.repos[s.contract.repo].path), s.contract.path);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, 'knowledge/contracts', `${s.name}${path.extname(src)}`)); published++; }
      else console.log(`  WARN  contract for ${s.name} not found at ${src}`);
    }
  }
  fs.writeFileSync(path.join(out, 'knowledge/catalog.yaml'), YAML.stringify({ services }));

  const copy = (rel) => { const src = raw.knowledge?.[rel] ? abs(raw.knowledge[rel]) : null; return src && fs.existsSync(src) ? src : null; };
  if (copy('agents')) fs.copyFileSync(copy('agents'), path.join(out, 'AGENTS.md'));
  if (copy('experts')) fs.cpSync(copy('experts'), path.join(out, 'knowledge/experts'), { recursive: true });
  if (flag('include-knowledge')) for (const k of ['decisions', 'learnings']) if (copy(k)) fs.cpSync(copy(k), path.join(out, `knowledge/${k}`), { recursive: true });

  // Last line of defence: flag any copied text that still names a repo this user must not know about.
  const hidden = Object.keys(raw.repos).filter((n) => !visible(n));
  const leaks = [];
  for (const f of fs.readdirSync(out, { recursive: true }).map(String)) {
    const fp = path.join(out, f);
    if (!fs.statSync(fp).isFile()) continue;
    const body = fs.readFileSync(fp, 'utf8');
    for (const n of hidden) if (body.includes(n)) leaks.push(`${f} mentions "${n}"`);
  }
  console.log(`Exported profile "${pname}" to ${out}`);
  for (const l of leaks) console.log(`  WARN  ${l}: edit it before sharing`);
  console.log(`  code access:      ${[...code].join(', ')}`);
  console.log(`  interface only:   ${[...iface].join(', ') || 'none'} (${published} contract(s) published)`);
  console.log(`  not included:     ${Object.keys(raw.repos).filter((n) => !visible(n)).length} repo(s)`);
  console.log(flag('include-knowledge') ? '  decisions and learnings copied: review them for mentions of other repos.' : '  decisions and learnings not copied (add --include-knowledge after reviewing them).');
}

if (cmd === 'init') init();
else if (cmd === 'export-profile') exportProfile();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'connect') connect();
else if (cmd === 'setup-tools') await setupTools();
else if (cmd === 'claude') await launchClaude();
else { console.error('Commands: init | doctor | connect | setup-tools | claude | export-profile'); process.exit(2); }
