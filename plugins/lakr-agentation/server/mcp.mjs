// A small MCP server over stdio (spec 2025-06-18): newline-delimited JSON-RPC 2.0 on stdin/stdout.
// No SDK on purpose: the plugin ships as plain files that run on any Node ≥ 22 with nothing to install,
// and the surface we need (initialize, tools/list, tools/call, ping) is small and stable.

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ToolError extends Error {}

/** Who is driving: Claude Code says "claude-code", Codex "codex-mcp-client". */
export const client = { name: '' };
export const agentName = () => (/codex/i.test(client.name) ? 'Codex' : /claude/i.test(client.name) ? 'Claude' : 'Your agent');

/** tools: [{name, description, inputSchema, run(args, ctx) → content[] | string}] */
export function serve({ name, version, instructions, tools }) {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
	const log = (...a) => process.stderr.write('[lakr] ' + a.join(' ') + '\n');

	const handle = async (msg) => {
		const { id, method, params } = msg;
		if (id === undefined) return; // notifications (initialized, cancelled): nothing to answer
		const reply = (result) => write({ jsonrpc: '2.0', id, result });
		const fail = (code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
		try {
			switch (method) {
				case 'initialize': {
					const asked = params?.protocolVersion;
					client.name = String(params?.clientInfo?.name ?? '');
					return reply({
						protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
						// claude/channel: Claude Code (started with --channels / the dev-channels flag) lets this server
						// push what the maker types in the preview straight into the session
						capabilities: { tools: { listChanged: false }, experimental: { 'claude/channel': {} } },
						serverInfo: { name, version },
						instructions,
					});
				}
				case 'ping':
					return reply({});
				case 'tools/list':
					return reply({
						tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
							name, title, description, inputSchema, ...(annotations ? { annotations } : {}),
						})),
					});
				case 'tools/call': {
					const tool = byName.get(params?.name);
					if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
					try {
						const out = await tool.run(params.arguments ?? {});
						const content = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
						return reply({ content });
					} catch (e) {
						// A tool's own failure is a RESULT the agent reads and fixes, not a protocol error.
						const text = e instanceof ToolError ? e.message : `Lakr hit an error: ${e?.stack ?? e}`;
						if (!(e instanceof ToolError)) log(String(e?.stack ?? e));
						return reply({ content: [{ type: 'text', text }], isError: true });
					}
				}
				default:
					return fail(-32601, `Method not found: ${method}`);
			}
		} catch (e) {
			log(String(e?.stack ?? e));
			return fail(-32603, String(e?.message ?? e));
		}
	};

	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
				continue;
			}
			for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
		}
	});
	process.stdin.on('end', () => process.exit(0));
	return { log };
}

/** A notification to the client (no reply expected). */
export const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

export const text = (t) => ({ type: 'text', text: t });
export const image = (buf, mimeType = 'image/jpeg') => ({ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType });
