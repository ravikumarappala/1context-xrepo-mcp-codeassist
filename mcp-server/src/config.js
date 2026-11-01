// Loads workspace.yaml and resolves the active profile (which repos this user may see).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export function loadConfig(configPath, profileName) {
  const file = path.resolve(configPath);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  const abs = (p) => path.resolve(base, p);

  const repos = Object.entries(raw.repos || {}).map(([name, r]) => ({
    name,
    path: abs(r.path),
    role: r.role || '',
    stack: r.stack || [],
    checks: r.checks || {},
  }));

  const profiles = raw.profiles || { owner: { repos: '*' } };
  const pname = profileName || raw.default_profile || 'owner';
  const profile = profiles[pname];
  if (!profile) throw new Error(`Unknown profile "${pname}". Defined: ${Object.keys(profiles).join(', ')}`);
  const allowed = profile.repos === '*' ? repos.map((r) => r.name) : profile.repos;
  for (const n of allowed) if (!repos.find((r) => r.name === n)) throw new Error(`Profile "${pname}" references unknown repo "${n}"`);
  // Interface-only dependencies: the assistant sees the catalog entry and published contract, never the code.
  // These repos need not be cloned (or even listed under repos:) on the user's machine.
  const contractOnly = (profile.contracts || []).filter((n) => !allowed.includes(n));

  return {
    name: raw.name || 'workspace',
    root: base,
    profile: pname,
    canWrite: profile.write_knowledge !== false,
    canRunChecks: profile.run_checks !== false,
    repos: repos.filter((r) => allowed.includes(r.name)),
    contractOnly,
    knowledge: {
      agents: raw.knowledge?.agents ? abs(raw.knowledge.agents) : null,
      catalog: raw.knowledge?.catalog ? abs(raw.knowledge.catalog) : null,
      experts: raw.knowledge?.experts ? abs(raw.knowledge.experts) : null,
      decisions: raw.knowledge?.decisions ? abs(raw.knowledge.decisions) : null,
      learnings: raw.knowledge?.learnings ? abs(raw.knowledge.learnings) : null,
      plans: raw.knowledge?.plans ? abs(raw.knowledge.plans) : null,
      contracts: abs(raw.knowledge?.contracts || 'knowledge/contracts'),
    },
    limits: {
      maxResults: raw.limits?.max_results ?? 40,
      maxFileBytes: raw.limits?.max_file_bytes ?? 60000,
      checkTimeoutSec: raw.limits?.check_timeout_sec ?? 600,
    },
  };
}
