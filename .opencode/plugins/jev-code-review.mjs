// jev-code-review — OpenCode plugin.
//
// Registers the `jev-code-review` MCP server and appends the same agent
// context that the Claude Code / Codex hooks inject (context.mjs) to every
// turn's system prompt.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL } from '../../context.mjs';
import { lintAfterEdit, readApiKey } from '../../review.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '../../server.mjs');

export default async () => {
  return {
    config: async (config) => {
      config.mcp = config.mcp || {};
      config.mcp['jev-code-review'] = { type: 'local', command: ['node', serverPath], enabled: true };
    },

    'experimental.chat.system.transform': async (_input, output) => {
      if (output.system.length > 0) {
        output.system[output.system.length - 1] += '\n\n' + FULL;
      } else {
        output.system.push(FULL);
      }
    },

    'tool.execute.after': async (input, output) => {
      const apiKey = readApiKey();
      if (!apiKey) return;
      const text = await lintAfterEdit({ cwd: process.cwd(), sessionId: input.sessionID ?? '', apiKey });
      if (text) output.output += '\n\n' + text;
    }
  };
};
