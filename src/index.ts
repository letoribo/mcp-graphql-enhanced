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
});

const env = EnvSchema.parse(process.env);

const server = new McpServer({
	name: env.NAME,
	version: getVersion(),
	description: `GraphQL MCP server for ${env.ENDPOINT}`,
});

server.resource("graphql-schema", new URL(env.ENDPOINT).href, async (uri: URL) => { 
	try {
		let schema;
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

		return {
			contents: [
				{
					uri: uri.href,
					text: schema,
				},
			],
		};
	} catch (error) {
		throw new Error(`Failed to get GraphQL schema: ${error}`);
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
        let schema;
        if (env.SCHEMA) {
          if (env.SCHEMA.startsWith("http://") || env.SCHEMA.startsWith("https://")) {
            schema = await introspectSchemaFromUrl(env.SCHEMA);
          } else {
            schema = await introspectLocalSchema(env.SCHEMA);
          }
        } else {
          schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
        }
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

/**
 * Tries to listen on a given port, automatically retrying on the next port if EADDRINUSE occurs.
 * @param server - The HTTP server instance.
 * @param port - The port to attempt binding to.
 * @param maxRetries - Maximum number of retries.
 * @param attempt - Current attempt number.
 * @returns Resolves with the bound server instance.
 */
function tryListen(server: http.Server, port: number, maxRetries = 5, attempt = 0): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		if (attempt >= maxRetries) {
			reject(
				new Error(
					`Failed to bind HTTP server after ${maxRetries} attempts, starting from port ${env.MCP_PORT}.`
				)
			);
			return;
		}

		if (port > 65535) {
			reject(new Error(`Exceeded maximum port number (65535) during retry.`));
			return;
		}

		const errorHandler = (err: NodeJS.ErrnoException) => {
			server.removeListener('error', errorHandler); // Remove listener to prevent memory leak

			if (err.code === 'EADDRINUSE') {
				const nextPort = port + 1;
				// Use console.error so it appears in the Inspector log
				console.error(
					`[HTTP] Port ${port} is in use (EADDRINUSE). Retrying on ${nextPort}...`
				);
				
				server.close(() => {
					// Recursively call tryListen with the next port
					resolve(tryListen(server, nextPort, maxRetries, attempt + 1));
				});
			} else {
				reject(err);
			}
		};
		
		server.on('error', errorHandler);

		server.listen(port, () => {
			server.removeListener('error', errorHandler); // success, remove the error listener
			console.error(
				`[HTTP] Started server on http://localhost:${port}. Listening for POST /mcp requests.`
			);
			resolve(server);
		});
	});
}

function startHttpTransport() {
	const serverInstance = http.createServer(handleHttpRequest);
	
	tryListen(serverInstance, env.MCP_PORT).catch((error) => {
		console.error(`[HTTP] Failed to start HTTP transport: ${error.message}`);
	});
}

async function main() {
	const stdioTransport = new StdioServerTransport();
	await server.connect(stdioTransport);

	startHttpTransport();

	console.error(
		`[STDIO] Started graphql mcp server ${env.NAME} for endpoint: ${env.ENDPOINT}`,
	);
}

main().catch((error) => {
	console.error(`Fatal error in main(): ${error}`);
	process.exit(1);
});