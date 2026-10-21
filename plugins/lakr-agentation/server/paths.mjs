// Where the plugin's own files are. In the built plugin this file sits at <plugin>/server/paths.mjs;
// in the source tree (agent-skill/src) the same layout is assembled by build.mjs, so LAKR_ROOT can point at a build.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(process.env.LAKR_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

/** Persistent per-user state (sign-in, caches): Claude Code's plugin data dir when it gives one, else ~/.lakr. */
export const DATA = path.resolve(process.env.LAKR_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.lakr'));

export const VERSION = '0.1.1';
