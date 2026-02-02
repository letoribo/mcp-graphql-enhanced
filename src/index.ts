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
    introspectSpecificTypes,
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
        .transform((value: string) => value === "true")
        .default("false"),
    HEADERS: z
        .string()
        .default("{}")
        .transform((val: string) => {
            try {
                return JSON.parse(val);
            } catch (e) {
                throw new Error("HEADERS must be a valid JSON string");
            }
        }),
    SCHEMA: z.string().optional(),
    MCP_PORT: z.preprocess(
        (val: unknown) => (val ? parseInt(val as string) : 6274),
        z.number().int().min(1024).max(65535)
    ).default(6274),
    ENABLE_HTTP: z
        .enum(["true", "false", "auto"])
        .transform((value: string) => {
            if (value === "auto") {
                return !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT);
            }
            return value === "true";
        })
        .default("auto"),
});

const env = EnvSchema.parse(process.env);

const server = new McpServer({
    name: env.NAME,
    version: getVersion(),
    description: `GraphQL MCP server for ${env.ENDPOINT}`,
});

// --- CACHE STATE ---
let cachedSDL: string | null = null;
let cachedSchemaObject: any = null;
let schemaLoadError: Error | null = null;

/**
 * Loads the schema into memory. 
 * Populates both cachedSDL (string) and cachedSchemaObject (GraphQLSchema object).
 */
async function getSchema(): Promise<string> {
    if (cachedSDL) return cachedSDL;
    if (schemaLoadError) throw schemaLoadError;

    try {
        const { buildClientSchema, getIntrospectionQuery, printSchema, buildASTSchema, parse: gqlParse } = require("graphql");
        let sdl: string;

        if (env.SCHEMA) {
            if (env.SCHEMA.startsWith("http")) {
                sdl = await introspectSchemaFromUrl(env.SCHEMA);
            } else {
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            cachedSchemaObject = buildASTSchema(gqlParse(sdl));
            cachedSDL = sdl;
        } else {
            // Live Introspection
            const response = await fetch(env.ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...env.HEADERS },
                body: JSON.stringify({ query: getIntrospectionQuery() }),
            });

            if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);

            const result = await response.json();
            cachedSchemaObject = buildClientSchema(result.data);
            cachedSDL = printSchema(cachedSchemaObject);
        }

        console.error(`[SCHEMA] Successfully loaded and cached GraphQL schema`);
        return cachedSDL!;
    } catch (error: unknown) {
        schemaLoadError = error instanceof Error ? error : new Error(String(error));
        throw schemaLoadError;
    }
}

// --- RESOURCES ---
server.resource("graphql-schema", new URL(env.ENDPOINT).href, async (uri: URL) => {
    try {
        const sdl = await getSchema();
        return { contents: [{ uri: uri.href, text: sdl }] };
    } catch (error) {
        throw error;
    }
});

// --- TOOL HANDLERS ---
const toolHandlers = new Map();

const introspectSchemaHandler = async ({ typeNames }: { typeNames?: string[] }) => {
    try {
        // Ensure cache is populated
        await getSchema();

        // Safety: If no specific types requested, return the 'Map' of types to prevent bridge crash
        if (!typeNames || typeNames.length === 0) {
            const allTypeNames = Object.keys(cachedSchemaObject.getTypeMap())
                .filter(t => !t.startsWith('__'));

            return {
                content: [{
                    type: "text",
                    text: `Schema is large. Please request specific types for full details.\n\nAvailable types: ${allTypeNames.join(", ")}`
                }]
            };
        }

        // Use the new filtering logic from helpers/introspection.js
        const filteredResult = introspectSpecificTypes(cachedSchemaObject, typeNames);

        return {
            content: [{
                type: "text",
                text: JSON.stringify(filteredResult, null, 2)
            }]
        };
    } catch (error: any) {
        throw new Error(`Introspection failed: ${error.message}`);
    }
};
toolHandlers.set("introspect-schema", introspectSchemaHandler);

server.tool(
    "introspect-schema",
    "Introspect the GraphQL schema. Optionally filter to specific types.",
    {
        typeNames: z.array(z.string()).optional().describe("A list of specific type names to filter (e.g. ['User', 'Post'])."),
    },
    async ({ typeNames }: { typeNames?: string[] }) => {
        try {
            console.error(`[TOOL] Introspect called with types: ${JSON.stringify(typeNames || "NONE")}`);
            
            // 1. Ensure the schema is loaded into the cache
            await getSchema();

            // 2. THE GATEKEEPER: If no types requested, send ONLY names.
            if (!typeNames || typeNames.length === 0) {
                const allTypeNames = Object.keys(cachedSchemaObject.getTypeMap())
                    .filter(t => !t.startsWith('__'));

                console.error(`[TOOL] Sending summary list of ${allTypeNames.length} types.`);
                
                return {
                    content: [{
                        type: "text",
                        text: `Schema is large. Please request specific types for details.\n\nAvailable types: ${allTypeNames.join(", ")}`
                    }]
                };
            }

            // 3. DRILL DOWN: If Claude asks for specific types, use the helper.
            console.error(`[TOOL] Filtering for: ${typeNames.join(", ")}`);
            const filteredResult = introspectSpecificTypes(cachedSchemaObject, typeNames);

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(filteredResult, null, 2)
                }]
            };
        } catch (error: any) {
            console.error(`[TOOL ERROR] ${error.message}`);
            throw new Error(`Introspection failed: ${error.message}`);
        }
    }
);

const queryGraphqlHandler = async ({ query, variables, headers }: any) => {
    try {
        const parsedQuery = parse(query);
        const isMutation = parsedQuery.definitions.some(
            (def: any) => def.kind === "OperationDefinition" && def.operation === "mutation",
        );

        if (isMutation && !env.ALLOW_MUTATIONS) {
            throw new Error("Mutations are not allowed. Enable ALLOW_MUTATIONS in config.");
        }
    } catch (error) {
        throw new Error(`Invalid GraphQL query: ${error}`);
    }

    try {
        const toolHeaders = headers ? JSON.parse(headers) : {};
        const allHeaders = { "Content-Type": "application/json", ...env.HEADERS, ...toolHeaders };

        let parsedVariables = variables;
        if (typeof variables === 'string') parsedVariables = JSON.parse(variables);

        const response = await fetch(env.ENDPOINT, {
            method: "POST",
            headers: allHeaders,
            body: JSON.stringify({ query, variables: parsedVariables }),
        });

        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`GraphQL request failed: ${response.statusText}\n${responseText}`);
        }

        const data = await response.json();
        if (data.errors && data.errors.length > 0) {
            throw new Error(`GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`);
        }

        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    } catch (error) {
        throw new Error(`Failed to execute GraphQL query: ${error}`);
    }
};
toolHandlers.set("query-graphql", queryGraphqlHandler);

server.tool(
    "query-graphql",
    "Query a GraphQL endpoint with the given query and variables.",
    {
        query: z.string(),
        variables: z.string().optional(),
        headers: z.string().optional().describe("Optional JSON string of headers"),
    },
    queryGraphqlHandler
);

// --- HTTP SERVER LOGIC ---
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url as string, `http://${req.headers.host}`);

    if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: env.NAME }));
        return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
        try {
            const rawBody = await readBody(req);
            const { method, params, id } = JSON.parse(rawBody);
            const handler = toolHandlers.get(method);

            if (!handler) {
                res.writeHead(404);
                res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
                return;
            }

            const result = await handler(params);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }));
        }
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
}

let httpServer: http.Server | null = null;

async function startHttpServer(initialPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
        let port = initialPort;
        const server = http.createServer(handleHttpRequest);
        server.once('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                server.close();
                resolve(startHttpServer(port + 1));
            } else reject(err);
        });
        server.listen(port, () => {
            httpServer = server;
            resolve(port);
        });
    });
}

// --- STARTUP ---
async function main() {
    console.error(`[SCHEMA] Pre-loading GraphQL schema...`);
    const schemaPromise = getSchema().catch(error => {
        console.error(`[SCHEMA] Warning: Failed to pre-load schema: ${error}`);
    });

    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error(`[STDIO] Started GraphQL MCP server ${env.NAME}`);

    if (env.ENABLE_HTTP) {
        try {
            const port = await startHttpServer(env.MCP_PORT);
            console.error(`[HTTP] Server started on http://localhost:${port}`);
        } catch (error) {
            console.error(`[HTTP] Failed to start: ${error}`);
        }
    }

    await schemaPromise;
}

// Graceful exit
const shutdown = () => {
    if (httpServer) httpServer.close(() => process.exit(0));
    else process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(error => {
    console.error(`Fatal error: ${error}`);
    process.exit(1);
});