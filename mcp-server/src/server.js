// MCP server: one shared, governed view of your repos and knowledge for every coding assistant.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { safeResolve } from './safety.js';
import { searchText } from './search.js';
import { runCheck } from './checks.js';
import * as K from './knowledge.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const RO = { readOnlyHint: true, openWorldHint: false };

/**
 * @param cfg     loaded config
 * @param reload  optional () => cfg; called when workspace.yaml changes so edits apply without restarting tools
 */
export function buildServer(initialCfg, { configPath, reload } = {}) {
  let cfg = initialCfg;
  let mtime = configPath ? fs.statSync(configPath).mtimeMs : 0;
  const refresh = () => {
    if (!configPath || !reload) return;
    try {
      const m = fs.statSync(configPath).mtimeMs;
      if (m !== mtime) { cfg = reload(); mtime = m; process.stderr.write('workspace-mcp: reloaded workspace.yaml\n'); }
    } catch (e) { process.stderr.write(`workspace-mcp: keeping previous config (${e.message})\n`); }
  };
  const server = new McpServer(
    { name: `workspace-${cfg.name}`, version: '0.1.0' },
    {
      instructions:
        `Shared context for the "${cfg.name}" workspace (profile: ${cfg.profile}). ` +
        'At session start call list_plans to resume work begun in another tool (Claude Code or Antigravity). ' +
        'Before writing new code: call find_reuse to check existing services; use get_service / get_contract before changing any API; ' +
        'load get_expert_pack for the stack you are editing; for changes spanning repos, call create_plan first and follow the release order; ' +
        'use workspace_status to check branches across repos; run run_check for each changed repo; ' +
        'before stopping or switching tools call update_plan with what changed and what is next; save non-obvious fixes with record_learning.',
    },
  );
  // Every tool call first picks up workspace.yaml edits (roles, repos, profiles, checks).
  const register = server.registerTool.bind(server);
  server.registerTool = (name, def, handler) => register(name, def, (...a) => { refresh(); return handler(...a); });

  // Which tool is calling (e.g. "claude-code", "antigravity"), for hand-off attribution in plans.
  const clientName = () => {
    const c = server.server.getClientVersion?.();
    return c?.name ? `${c.name}` : 'assistant';
  };

  const repoByName = (n) => cfg.repos.find((r) => r.name === n);
  const names = () => cfg.repos.map((r) => r.name);
  const repoNames = { join: (s) => names().join(s) };

  server.registerTool('workspace_overview', {
    title: 'Workspace overview',
    description: 'Repos you can access, their roles and stacks, available expert packs, and the workspace rules (AGENTS.md). Call first in a new session.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const repos = cfg.repos.map((r) => `- ${r.name}: ${r.role} [${r.stack.join(', ')}]${Object.keys(r.checks).length ? ` · checks: ${Object.keys(r.checks).join(', ')}` : ''}`).join('\n');
    const experts = K.listMarkdown(cfg.knowledge.experts).map((f) => f.replace(/\.md$/, '')).join(', ') || 'none';
    const iface = cfg.contractOnly?.length ? `\n\nInterface-only dependencies (contracts, no code): ${cfg.contractOnly.join(', ')}. Use get_service / get_contract; do not guess their internals.` : '';
    const rules = cfg.knowledge.agents && fs.existsSync(cfg.knowledge.agents) ? K.readCapped(cfg.knowledge.agents, 12000) : '(no workspace AGENTS.md configured)';
    return text(`Workspace: ${cfg.name} · profile: ${cfg.profile}\n\nRepos:\n${repos}${iface}\n\nExpert packs: ${experts}\n\n--- Workspace rules ---\n${rules}`);
  });

  server.registerTool('find_reuse', {
    title: 'Find existing solutions',
    description: 'Search the service catalog and code for something that already does what you need (auth, uploads, OCR, payments...). Use before writing new code.',
    inputSchema: { need: z.string().min(2).max(200).describe('What you need, in a few words') },
    annotations: RO,
  }, async ({ need }) => {
    const services = K.loadCatalog(cfg).map((s) => ({ s, score: K.scoreService(s, need) })).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score).slice(0, 8);
    const svc = services.length
      ? services.map(({ s }) => `- ${s.name} (${s.repo}${s.path ? `/${s.path}` : ''})${s.reusable ? ' [reusable]' : ''}${s.contractOnly ? ' [interface only]' : ''}: ${s.description || ''}${s.package ? ` · use as: ${s.package}` : ''}`).join('\n')
      : '(no catalog match)';
    const first = need.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    const hits = await searchText(cfg.repos, first, { maxResults: 15 });
    const code = hits.length ? hits.map((h) => `- ${h.repo}/${h.file}:${h.line}  ${h.text}`).join('\n') : '(no code match)';
    return text(`Catalog matches:\n${svc}\n\nCode mentions of "${first}":\n${code}\n\nPrefer extending a reusable service over writing a new one.`);
  });

  server.registerTool('get_service', {
    title: 'Service details and consumers',
    description: 'Catalog entry for a service: location, stack, cloud, contract, package, and every consumer that a change could break.',
    inputSchema: { name: z.string().min(1).max(100) },
    annotations: RO,
  }, async ({ name }) => {
    const all = K.loadCatalog(cfg);
    const s = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) return fail(`No service "${name}" in your catalog. Known: ${all.map((x) => x.name).join(', ') || 'none'}`);
    const consumers = (s.consumers || []).map((c) => `- ${typeof c === 'string' ? c : `${c.repo}${c.via ? ` via ${c.via}` : ''}`}`).join('\n') || '- none recorded';
    return text([
      `# ${s.name}`, s.description || '',
      `Repo: ${s.repo}${s.path ? `/${s.path}` : ''}`,
      s.products?.length ? `Products: ${s.products.join(', ')}` : '', `Stack: ${(s.stack || []).join(', ')}`, s.cloud ? `Cloud: ${s.cloud}` : '',
      `Reusable: ${s.reusable ? 'yes' : 'no'}${s.package ? ` · package: ${s.package}` : ''}`,
      s.contractOnly ? 'Access: interface only. Code is not available to your profile; integrate through the contract and package.' : '',
      `Contract: ${s.contract ? `${s.contract.repo}/${s.contract.path}` : 'none recorded'}`,
      `\nConsumers (impact of a change):\n${consumers}`,
      s.notes ? `\nNotes: ${s.notes}` : '',
    ].filter(Boolean).join('\n'));
  });

  server.registerTool('get_contract', {
    title: 'API contract',
    description: 'Read the API contract (e.g. OpenAPI) for a service. Change the contract first, then implementations.',
    inputSchema: { service: z.string().min(1).max(100) },
    annotations: RO,
  }, async ({ service }) => {
    const s = K.loadCatalog(cfg).find((x) => x.name.toLowerCase() === service.toLowerCase());
    if (!s) return fail(`No service "${service}" in your catalog.`);
    const repo = s.contract && repoByName(s.contract.repo);
    try {
      if (repo) return text(K.readCapped(safeResolve(repo.path, s.contract.path), cfg.limits.maxFileBytes));
      // Interface-only users read the copy the owner published into the workspace.
      const pub = K.publishedContract(cfg, s.name);
      if (pub) return text(`(published contract for ${s.name})\n${K.readCapped(pub, cfg.limits.maxFileBytes)}`);
      return fail(s.contract ? `The contract for "${s.name}" has not been published to this workspace. Ask the owner to run export-profile.` : `No contract recorded for "${service}".`);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('search_code', {
    title: 'Search code across repos',
    description: 'Search all repos you can access (or selected ones). Returns file:line snippets, not whole files, to save tokens.',
    inputSchema: {
      query: z.string().min(2).max(200),
      repos: z.array(z.string()).optional().describe(`Limit to these repos: ${repoNames.join(', ')}`),
      glob: z.string().max(100).optional().describe('e.g. "**/*.swift" or "src/**/*.js"'),
      regex: z.boolean().optional(),
    },
    annotations: RO,
  }, async ({ query, repos, glob, regex }) => {
    const roots = repos?.length ? cfg.repos.filter((r) => repos.includes(r.name)) : cfg.repos;
    if (repos?.length && roots.length !== repos.length) return fail(`Unknown or inaccessible repo. Accessible: ${repoNames.join(', ')}`);
    try {
      const hits = await searchText(roots, query, { glob, regex, maxResults: cfg.limits.maxResults });
      if (!hits.length) return text('No matches.');
      return text(hits.map((h) => `${h.repo}/${h.file}:${h.line}  ${h.text}`).join('\n') + (hits.length >= cfg.limits.maxResults ? '\n[more results exist; narrow with repos or glob]' : ''));
    } catch (e) { return fail(`Search failed: ${e.message}`); }
  });

  server.registerTool('read_file', {
    title: 'Read a file from another repo',
    description: 'Read part of a file in any accessible repo (useful for repos not open in your editor). Use line ranges to save tokens.',
    inputSchema: {
      repo: z.string(), path: z.string().max(400),
      start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(),
    },
    annotations: RO,
  }, async ({ repo, path: rel, start_line, end_line }) => {
    const r = repoByName(repo);
    if (!r) return fail(`Unknown or inaccessible repo. Accessible: ${repoNames.join(', ')}`);
    try {
      const file = safeResolve(r.path, rel);
      if (!fs.statSync(file).isFile()) return fail('Not a file.');
      if (!start_line && !end_line) return text(K.readCapped(file, cfg.limits.maxFileBytes));
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const s = (start_line || 1) - 1; const e = Math.min(end_line || lines.length, s + 400);
      return text(lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n'));
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('get_expert_pack', {
    title: 'Expert pack',
    description: 'Your conventions for a stack (ios, python, java, dotnet, aws-terraform, gcp-terraform...). Load before editing code in that stack.',
    inputSchema: { stack: z.string().min(1).max(50) },
    annotations: RO,
  }, async ({ stack }) => {
    const packs = K.listMarkdown(cfg.knowledge.experts);
    const f = packs.find((p) => p.replace(/\.md$/, '').toLowerCase() === K.slug(stack));
    if (!f) return fail(`No expert pack "${stack}". Available: ${packs.map((p) => p.replace(/\.md$/, '')).join(', ') || 'none'}`);
    return text(K.readCapped(path.join(cfg.knowledge.experts, f), cfg.limits.maxFileBytes));
  });

  server.registerTool('search_knowledge', {
    title: 'Search decisions and learnings',
    description: 'Search architecture decisions and recorded learnings (past bugs, fixes, rules) before repeating a mistake.',
    inputSchema: { query: z.string().min(2).max(200) },
    annotations: RO,
  }, async ({ query }) => {
    const roots = [['decisions', cfg.knowledge.decisions], ['learnings', cfg.knowledge.learnings]]
      .filter(([, p]) => p && fs.existsSync(p)).map(([name, p]) => ({ name, path: p }));
    const hits = await searchText(roots, query, { glob: '*.md', maxResults: 20 });
    return text(hits.length ? hits.map((h) => `${h.repo}/${h.file}:${h.line}  ${h.text}`).join('\n') : 'No decisions or learnings match.');
  });

  server.registerTool('create_plan', {
    title: 'Create a cross-repo change plan',
    description: 'Write plans/<feature>.md listing the change per repo in release order. Call before editing more than one repo.',
    inputSchema: {
      feature: z.string().min(3).max(120),
      goal: z.string().min(3).max(2000),
      steps: z.array(z.object({ repo: z.string(), change: z.string().min(3).max(2000), checks: z.string().max(200).optional() })).min(1).max(12),
      branch: z.string().regex(/^[A-Za-z0-9._/-]{1,80}$/).optional().describe('Branch name used in every repo; default feature/<slug>'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ feature, goal, steps, branch }) => {
    if (!cfg.canWrite) return fail('Your profile cannot write plans. Share the plan with the workspace owner instead.');
    if (!cfg.knowledge.plans) return fail('No plans directory configured.');
    const bad = steps.filter((s) => !repoByName(s.repo)).map((s) => s.repo);
    if (bad.length) return fail(`Unknown or inaccessible repos: ${bad.join(', ')}`);
    const br = branch || `feature/${K.slug(feature)}`;
    const file = K.writeNew(cfg.knowledge.plans, `${K.today()}-${K.slug(feature)}`, K.planMarkdown({ feature, goal, steps, profile: cfg.profile, branch: br, by: clientName() }));
    return text(`Plan written: ${path.relative(cfg.root, file)} (id: ${path.basename(file, '.md')})\nBranch for every repo: ${br}\n` +
      'Record progress with update_plan as you go; any tool (Claude Code or Antigravity) can resume with get_plan.');
  });

  // ---------- Context hand-off between tools (Claude Code <-> Antigravity) ----------
  const planFiles = () => K.listMarkdown(cfg.knowledge.plans).filter((f) => f !== 'README.md');
  const findPlan = (id) => {
    const files = planFiles();
    const q = K.slug(id);
    return files.find((f) => f === `${id}.md` || f.replace(/\.md$/, '') === id) || files.find((f) => f.includes(q));
  };

  server.registerTool('list_plans', {
    title: 'List plans',
    description: 'Cross-repo plans with status, branch and last progress note. Call at the start of a session to resume work started in another tool.',
    inputSchema: { include_done: z.boolean().optional() },
    annotations: RO,
  }, async ({ include_done }) => {
    if (!cfg.knowledge.plans || !fs.existsSync(cfg.knowledge.plans)) return text('No plans yet.');
    const rows = planFiles().reverse().map((f) => {
      const md = fs.readFileSync(path.join(cfg.knowledge.plans, f), 'utf8');
      return { id: f.replace(/\.md$/, ''), title: K.planTitle(md), status: K.planStatus(md), branch: K.planBranch(md), last: K.lastLog(md) };
    }).filter((p) => include_done || !['done', 'abandoned'].includes(p.status));
    if (!rows.length) return text('No open plans.');
    return text(rows.map((p) => `- ${p.id} [${p.status}] ${p.title}${p.branch ? ` · branch ${p.branch}` : ''}\n    last: ${p.last || '-'}`).join('\n'));
  });

  server.registerTool('get_plan', {
    title: 'Get a plan',
    description: 'Full plan: goal, per-repo changes, checklist and progress log. Use it to continue work another tool started.',
    inputSchema: { id: z.string().min(2).max(120).describe('Plan id from list_plans, or words from its title') },
    annotations: RO,
  }, async ({ id }) => {
    const f = cfg.knowledge.plans && findPlan(id);
    if (!f) return fail(`No plan matches "${id}". Use list_plans.`);
    return text(K.readCapped(path.join(cfg.knowledge.plans, f), cfg.limits.maxFileBytes));
  });

  server.registerTool('update_plan', {
    title: 'Record plan progress / hand off',
    description: 'Append a progress note (what changed, where you stopped, what is next), tick finished steps and set status. ' +
      'Call before ending a session or switching tools so the next tool can continue.',
    inputSchema: {
      id: z.string().min(2).max(120),
      note: z.string().min(3).max(2000).describe('What was done, files touched, open issues, next step'),
      status: z.enum(K.PLAN_STATUSES).optional(),
      steps_done: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note, status, steps_done }) => {
    if (!cfg.canWrite) return fail('Your profile cannot update plans.');
    const f = cfg.knowledge.plans && findPlan(id);
    if (!f) return fail(`No plan matches "${id}". Use list_plans.`);
    const file = path.join(cfg.knowledge.plans, f);
    fs.writeFileSync(file, K.applyPlanUpdate(fs.readFileSync(file, 'utf8'), { note, status, stepsDone: steps_done || [], by: clientName() }));
    return text(`Updated ${f.replace(/\.md$/, '')}${status ? ` (status: ${status})` : ''}.`);
  });

  server.registerTool('workspace_status', {
    title: 'Git status across repos',
    description: 'Current branch, uncommitted changes and last commit for every repo; flags repos not on the plan branch.',
    inputSchema: { plan: z.string().max(120).optional().describe('Plan id to compare branches against') },
    annotations: RO,
  }, async ({ plan }) => {
    let want = null;
    if (plan) {
      const f = cfg.knowledge.plans && findPlan(plan);
      if (!f) return fail(`No plan matches "${plan}".`);
      want = K.planBranch(fs.readFileSync(path.join(cfg.knowledge.plans, f), 'utf8'));
    }
    const git = (cwd, args) => { try { return execFileSync('git', args, { cwd, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
    const lines = cfg.repos.map((r) => {
      if (!fs.existsSync(r.path)) return `- ${r.name}: path missing`;
      const branch = git(r.path, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
      // "-- ." scopes status and history to this folder, so it also works when several "repos" share one git repo.
      const dirty = (git(r.path, ['status', '--porcelain', '--', '.']) || '').split('\n').filter(Boolean);
      const last = git(r.path, ['log', '-1', '--format=%h %s (%cr)', '--', '.']) || '-';
      const flag = want && branch !== want ? `  <- not on ${want}` : '';
      return `- ${r.name}: ${branch}${dirty.length ? ` · ${dirty.length} uncommitted: ${dirty.slice(0, 4).map((d) => d.slice(3)).join(', ')}${dirty.length > 4 ? ' …' : ''}` : ' · clean'} · last: ${last}${flag}`;
    });
    return text(lines.join('\n'));
  });

  server.registerTool('record_learning', {
    title: 'Record a learning',
    description: 'Save a non-obvious bug, fix or rule so every tool and teammate benefits. Saved as "proposed" for owner review.',
    inputSchema: {
      title: z.string().min(3).max(120), problem: z.string().min(3).max(3000), fix: z.string().min(3).max(3000),
      tags: z.array(z.string().max(30)).max(8).optional(), repos: z.array(z.string()).max(8).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    if (!cfg.canWrite) return fail('Your profile cannot write learnings. Send it to the workspace owner.');
    if (!cfg.knowledge.learnings) return fail('No learnings directory configured.');
    const file = K.writeNew(cfg.knowledge.learnings, `${K.today()}-${K.slug(args.title)}`, K.learningMarkdown({ ...args, profile: cfg.profile }));
    return text(`Learning saved for review: ${path.relative(cfg.root, file)}`);
  });

  server.registerTool('run_check', {
    title: 'Run a repo check',
    description: 'Run a predefined check (test, build, lint, contract) in a repo and get the result tail. Only commands defined in workspace.yaml can run.',
    inputSchema: { repo: z.string(), check: z.string().min(1).max(40) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ repo, check }) => {
    if (!cfg.canRunChecks) return fail('Your profile cannot run checks.');
    const r = repoByName(repo);
    if (!r) return fail(`Unknown or inaccessible repo. Accessible: ${repoNames.join(', ')}`);
    const res = await runCheck(r, check, cfg.limits.checkTimeoutSec);
    return res.ok ? text(`PASS\n${res.output}`) : fail(`FAIL\n${res.output}`);
  });

  return server;
}
