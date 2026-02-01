#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { parse } = require("graphql/language");
const z = require("zod").default;

const { checkDeprecatedArguments } = require("./helpers/deprecation.js");
const {
	introspectEndpoint,
	introspectLocalSchema,
	introspectSchemaFromUrl,
	introspectTypes,
} = require("./helpers/introspection.js");

const getVersion = () => {
	const pkg = require("../package.json");
	return pkg.version;
};

checkDeprecatedArguments();

const EnvSchema = z.object({
	NAME: z.string().default("mcp-graphql-enhanced"),
	ENDPOINT: z.preprocess(
		(val: unknown) => (typeof val === 'string' ? val.trim() : val),
		z.string().url("ENDPOINT must be a valid URL (e.g., https://example.com/graphql)")
	).default("https://mcp-neo4j-discord.vercel.app/api/graphiql"),
	ALLOW_MUTATIONS: z
		.enum(["true", "false"])
		.transform(
			(value: string) => value === "true"
		)
		.default("false"),
	HEADERS: z
		.string()
		.default("{}")
		.transform(
			(val: string) => {
				try {
					return JSON.parse(val);
				} catch (e) {
					throw new Error("HEADERS must be a valid JSON string");
				}
			}
		),
	SCHEMA: z.string().optional(),
	MCP_PORT: z.preprocess(
		(val: unknown) => (val ? parseInt(val as string) : 6274),
		z.number().int().min(1024).max(65535)
	).default(6274),
	ENABLE_HTTP: z
		.enum(["true", "false", "auto"])
		.transform((value: string) => {
			if (value === "auto") {
				// Auto-detect: enable HTTP if running in MCP Inspector
				// Inspector sets specific environment variables
				return !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT);
			}
			return value === "true";
		})
		.default("auto"), // Auto-detect by default
});

const env = EnvSchema.parse(process.env);

const server = new McpServer({
	name: env.NAME,
	version: getVersion(),
	description: `GraphQL MCP server for ${env.ENDPOINT}`,
});


// Cache schema to avoid repeated introspection
let cachedSchema: string | null = null;
let schemaLoadError: Error | null = null;

async function getSchema(): Promise<string> {
	// Return cached schema if available
	if (cachedSchema) {
		return cachedSchema;
	}

	// Return cached error if schema failed to load
	if (schemaLoadError) {
		throw schemaLoadError;
	}

	try {
		let schema: string;
		if (env.SCHEMA) {
			if (
				env.SCHEMA.startsWith("http://") ||
				env.SCHEMA.startsWith("https://")
			) {
				schema = await introspectSchemaFromUrl(env.SCHEMA);
			} else {
				schema = await introspectLocalSchema(env.SCHEMA);
			}
		} else {
			schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
		}
		
		// Cache the schema
		cachedSchema = schema;
		console.error(`[SCHEMA] Successfully loaded and cached GraphQL schema`);
		return schema;
	} catch (error) {
		schemaLoadError = error as Error;
		throw new Error(`Failed to get GraphQL schema: ${error}`);
	}
}

server.resource("graphql-schema", new URL(env.ENDPOINT).href, async (uri: URL) => { 
	try {
		const schema = await getSchema();
		return {
			contents: [
				{
					uri: uri.href,
					text: schema,
				},
			],
		};
	} catch (error) {
		throw error;
	}
});

const toolHandlers = new Map();

const introspectSchemaHandler = async ({ typeNames, descriptions = true, directives = true }: any) => {
    if (typeNames === null) {
      typeNames = undefined;
    }
	try {
      if (typeNames && typeNames.length > 0) {
        const filtered = await introspectTypes(env.ENDPOINT, env.HEADERS, typeNames);
        return { content: [{ type: "text", text: filtered }] };
      } else {
        const schema = await getSchema();
        return { content: [{ type: "text", text: schema }] };
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Introspection failed: ${error}` }],
      };
    }
};
toolHandlers.set("introspect-schema", introspectSchemaHandler);

server.tool(
  "introspect-schema",
  "Introspect the GraphQL schema. Optionally filter to specific types.",
  {
    typeNames: z.array(z.string()).optional().describe("A list of specific type names to filter the introspection."),
    descriptions: z.boolean().optional().default(true),
    directives: z.boolean().optional().default(true),
  },
  introspectSchemaHandler
);

const queryGraphqlHandler = async ({ query, variables, headers }: any) => {
	try {
		const parsedQuery = parse(query);

		const isMutation = parsedQuery.definitions.some(
			(def: any) =>
				def.kind === "OperationDefinition" && def.operation === "mutation",
		);

		if (isMutation && !env.ALLOW_MUTATIONS) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "Mutations are not allowed unless you enable them in the configuration. Please use a query operation instead.",
					},
				],
			};
		}
	} catch (error) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Invalid GraphQL query: ${error}`,
				},
			],
		};
	}

	try {
		const toolHeaders = headers
			? JSON.parse(headers)
			: {};

		const allHeaders = {
			"Content-Type": "application/json",
			...env.HEADERS,
			...toolHeaders,
		};

		let parsedVariables = null;
		if (variables) {
			if (typeof variables === 'string') {
				parsedVariables = JSON.parse(variables);
			} else {
				parsedVariables = variables;
			}
		}

		const response = await fetch(env.ENDPOINT, {
			method: "POST",
			headers: allHeaders,
			body: JSON.stringify({
				query,
				variables: parsedVariables,
			}),
		});

		if (!response.ok) {
			const responseText = await response.text();
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `GraphQL request failed: ${response.statusText}\n${responseText}`,
					},
				],
			};
		}

		const rawData = await response.json();

		const data = rawData;

		if (data.errors && data.errors.length > 0) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`,
					},
				],
			};
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(data, null, 2),
				},
			],
		};
	} catch (error) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Failed to execute GraphQL query: ${error}`,
				},
			],
		};
	}
};
toolHandlers.set("query-graphql", queryGraphqlHandler);

server.tool(
	"query-graphql",
	"Query a GraphQL endpoint with the given query and variables. Optionally pass headers (e.g., for Authorization).",
	{
		query: z.string(),
		variables: z.string().optional(),
		headers: z
			.string()
			.optional()
			.describe("Optional JSON string of headers to include, e.g., {\"Authorization\": \"Bearer ...\"}"),
	},
	queryGraphqlHandler
);

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk: string | Buffer) => {
			body += chunk.toString();
		});
		req.on('end', () => {
			resolve(body);
		});
		req.on('error', reject);
	});
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url as string, `http://${req.headers.host}`);

	if (url.pathname === '/health' && req.method === 'GET') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', server: env.NAME }));
		return;
	}

	if (url.pathname === '/mcp' && req.method === 'POST') {
		let rawBody: string;
		let request: any;

		try {
			rawBody = await readBody(req);
			request = JSON.parse(rawBody);
		} catch (e) {
			console.error("HTTP MCP Parse Error:", e);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: 'Parse Error: Invalid JSON received in request body.' }
			}));
			return;
		}

		try {
			const { method, params, id } = request;

			if (!method || typeof id === 'undefined') {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					id: id || null,
					error: { code: -32600, message: 'Invalid JSON-RPC Request structure (missing method or id).' }
				}));
				return;
			}
			
			const handler = toolHandlers.get(method);
			if (!handler) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					id: id,
					error: { code: -32601, message: `Method not found: ${method}` }
				}));
				return;
			}

			const result = await handler(params);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				jsonrpc: '2.0',
				id: id,
				result: result
			}));

		} catch (error) {
			console.error("HTTP MCP Execution Error:", error);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				jsonrpc: '2.0',
				id: request?.id || null,
				error: { code: -32603, message: 'Internal server error during tool execution.' }
			}));
		}
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found. Use POST /mcp for JSON-RPC or GET /health.');
}

// Single HTTP server instance
let httpServer: http.Server | null = null;

/**
 * Tries to listen on a given port with a single retry attempt.
 * Returns the port it successfully bound to.
 */
async function startHttpServer(initialPort: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let currentPort = initialPort;
		const maxAttempts = 10;
		let attempts = 0;

		function tryPort(port: number) {
			if (attempts >= maxAttempts) {
				reject(new Error(`Failed to bind HTTP server after ${maxAttempts} attempts`));
				return;
			}

			if (port > 65535) {
				reject(new Error(`Exceeded maximum port number (65535)`));
				return;
			}

			attempts++;
			const server = http.createServer(handleHttpRequest);

			server.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE') {
					console.error(`[HTTP] Port ${port} in use, trying ${port + 1}...`);
					server.close();
					tryPort(port + 1);
				} else {
					reject(err);
				}
			});

			server.listen(port, () => {
				httpServer = server;
				console.error(`[HTTP] Server started on http://localhost:${port}`);
				resolve(port);
			});
		}

		tryPort(currentPort);
	});
}

async function main() {
	const stdioTransport = new StdioServerTransport();
	await server.connect(stdioTransport);

	// Only start HTTP server if explicitly enabled
	if (env.ENABLE_HTTP) {
		try {
			const port = await startHttpServer(env.MCP_PORT);
			console.error(`[HTTP] Listening on port ${port} for POST /mcp requests`);
		} catch (error) {
			console.error(`[HTTP] Failed to start HTTP server: ${error}`);
			// Don't exit - STDIO transport is more important
		}
	} else {
		console.error(`[HTTP] HTTP transport disabled (ENABLE_HTTP=auto|true to enable)`);
	}

	try {
		await getSchema();
	} catch (error) {
		console.error(`[SCHEMA] Warning: Failed to pre-load schema: ${error}`);
	}
}

// Graceful shutdown
process.on('SIGINT', () => {
	console.error('\n[SHUTDOWN] Received SIGINT, closing server...');
	if (httpServer) {
		httpServer.close(() => {
			console.error('[SHUTDOWN] HTTP server closed');
			process.exit(0);
		});
	} else {
		process.exit(0);
	}
});

process.on('SIGTERM', () => {
	console.error('\n[SHUTDOWN] Received SIGTERM, closing server...');
	if (httpServer) {
		httpServer.close(() => {
			console.error('[SHUTDOWN] HTTP server closed');
			process.exit(0);
		});
	} else {
		process.exit(0);
	}
});

main().catch((error) => {
	console.error(`Fatal error in main(): ${error}`);
	process.exit(1);
});