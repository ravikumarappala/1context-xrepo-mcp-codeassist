#!/usr/bin/env node
// Local stdio entry point. Every coding tool launches this process itself; nothing listens on the network.
//   xrepo-mcp --config ~/work/acme/workspace.yaml [--profile owner]
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const configPath = arg('config') || process.env.WORKSPACE_MCP_CONFIG;
if (!configPath) {
  process.stderr.write('Usage: xrepo-mcp --config /path/to/workspace.yaml [--profile name]\n');
  process.exit(2);
}

try {
  const profile = arg('profile') || process.env.WORKSPACE_MCP_PROFILE;
  const cfg = loadConfig(configPath, profile);
  const server = buildServer(cfg, { configPath, reload: () => loadConfig(configPath, profile) });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`workspace-mcp ready: ${cfg.name} (profile ${cfg.profile}, ${cfg.repos.length} repos)\n`); // stderr only: stdout is the MCP channel
} catch (e) {
  process.stderr.write(`workspace-mcp failed to start: ${e.message}\n`);
  process.exit(1);
}
