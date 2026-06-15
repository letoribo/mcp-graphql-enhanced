#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse } from "graphql/language";
import z from "zod";
import { renderGraphiQL} from "./helpers/graphiql.js";
import type { GraphQLSchema } from "graphql";

// Helper imports
import { checkDeprecatedArguments } from "./helpers/deprecation.js";
import {
    introspectLocalSchema,
    introspectSpecificTypes,
} from "./helpers/introspection.js";
import { registerTool } from "./helpers/tool-registry.js";
import { registerPrompt } from "./helpers/prompt-registry.js";

/**
 * Retrieves the current version from package.json
 */
const getVersion = () => {
    try {
        const pkg = require("../package.json");
        return pkg.version;
    } catch {
        return "dev-version";
    }
};

checkDeprecatedArguments();

/**
 * Environment configuration schema - Strict validation
 */
const EnvSchema = z.object({
    NAME: z.string().default("mcp-graphql-enhanced"),
    ENDPOINT: z.preprocess(
        (val: unknown) => {
            if (typeof val === 'string') return val.trim();
            return val;
        },
        z.string().min(1) 
    ).default("https://mcp-discord.vercel.app/api/graphiql"),
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
                return !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT || process.env.MCP_PORT);
            }
            return value === "true";
        })
        .default("auto"),
    // Support for custom instance authorization via environment variables
    example_env1: z.string().optional(),
    example_env2: z.string().optional(),
});

const env = EnvSchema.parse(process.env);

/**
 * Build dynamic auth headers for nodes that require credentials
 */
function getEffectiveHeaders(): Record<string, string> {
    const baseHeaders = { ...env.HEADERS };
    if (env.example_env1 && env.example_env2) {
        baseHeaders["X-Auth-Username"] = env.example_env1;
        baseHeaders["X-Auth-Password"] = env.example_env2;
    }
    return baseHeaders;
}

/**
 * Initialize MCP Server with full capabilities
 */
const server = new McpServer({
    name: env.NAME,
    version: getVersion(),
    description: "Federated GraphQL-to-MCP bridge with broadcast introspection and full type visibility."
}, {
    capabilities: {
        prompts: {},
        tools: {}
    }
});

// --- GLOBAL STATE MANAGEMENT ---
let cachedSDL: string | null = null;
let cachedSchemaObject: any = null;
let cachedSchemas: Array<GraphQLSchema & { _originUrl?: string }> = [];
let schemaLoadError: Error | null = null;
let isUpdating = false;
let updatePromise: Promise<string> | null = null;

/**
 * Schema Fetcher with dependency tracking
 */
async function getSchema(force: boolean = false, requestedTypes?: string[]): Promise<string | GraphQLSchema> {
    if (isUpdating && updatePromise) {
        if (force || !cachedSDL) return await updatePromise;
        return cachedSDL;
    }

    if (cachedSDL && !force) {
        if (requestedTypes && cachedSchemas.length > 0) {
            const allTypes = new Set(cachedSchemas.flatMap(s => Object.keys(s.getTypeMap())));
            const missing = requestedTypes.filter(t => !allTypes.has(t));
            if (missing.length > 0) return await (updatePromise = performUpdate(true));
        }
        return cachedSchemaObject;
    }

    if (force) schemaLoadError = null;
    if (schemaLoadError) throw schemaLoadError;

    updatePromise = performUpdate(force);
    
    try {
        if (force || !cachedSDL) {
            await updatePromise;
            return cachedSchemaObject;
        }
        return cachedSchemaObject;
    } finally {
        updatePromise = null;
    }
}

/**
 * Federated Update: Orchestrates introspection across all endpoints
 */
async function performUpdate(force: boolean): Promise<string> {
    isUpdating = true;
    const startTime = Date.now();

    try {
        const { buildClientSchema, getIntrospectionQuery, printSchema, buildASTSchema, parse: gqlParse, isObjectType } = require("graphql");
        let tempSchemas: any[] = [];
        const manifest: any[] = [];

        const activeHeaders = getEffectiveHeaders();

        // --- FETCHING LOGIC: LOCAL SDL OR REMOTE BROADCAST ---
        if (env.SCHEMA) {
            let sdl: string;
            if (env.SCHEMA.startsWith("http")) {
                const response = await fetch(env.SCHEMA);
                if (!response.ok) throw new Error(`Remote_SDL_Fetch_Failed: ${response.statusText}`);
                sdl = await response.text();
            } else {
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            const localSchema = buildASTSchema(gqlParse(sdl));
            localSchema._originUrl = "local-sdl";
            tempSchemas = [localSchema];
            
            manifest.push({
                endpoint: "Local SDL File",
                availableMutations: ["*"],
                domainEntities: Object.keys(localSchema.getTypeMap()).filter(t => !t.startsWith('__'))
            });
        } else {
            const endpoints = env.ENDPOINT.split(',').map(url => url.trim());
            
            const results = await Promise.all(endpoints.map(async (url) => {
                try {
                    const response = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...activeHeaders },
                        body: JSON.stringify({ query: getIntrospectionQuery() }),
                    });
                    if (!response.ok) return null;
                    const result = await response.json();
                    if (!result.data) return null;

                    const schemaInstance = buildClientSchema(result.data);
                    schemaInstance._originUrl = url;

                    const typeMap = schemaInstance.getTypeMap();
                    const entities = Object.keys(typeMap).filter(t => !t.startsWith('__') && !['Query', 'Mutation', 'Subscription'].includes(t));
                    const hasMutation = !!typeMap['Mutation'];

                    manifest.push({
                        endpoint: url,
                        availableMutations: hasMutation ? ["Dynamic CRUD"] : [],
                        domainEntities: entities
                    });

                    return schemaInstance;
                } catch (e) {
                    console.error(`[SYNC-WARN] Failed to reach ${url}`);
                    return null;
                }
            }));

            tempSchemas = results.filter((s) => s !== null);
        }

        if (tempSchemas.length === 0) {
            throw new Error("No valid schemas could be retrieved.");
        }

        cachedSchemas = tempSchemas;
        (global as any).nodeManifest = manifest;

        cachedSchemaObject = cachedSchemas[0]; 
        const currentSDL = printSchema(cachedSchemaObject);

        const typeMap = cachedSchemaObject.getTypeMap();
        const businessTypes = Object.keys(typeMap).filter(typeName => {
            const type = typeMap[typeName];
            return !typeName.startsWith('__') && 
                   !['Query', 'Mutation', 'Subscription'].includes(typeName) &&
                   isObjectType(type);
        });

        if (currentSDL !== cachedSDL) {
            cachedSDL = currentSDL;
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const sourceInfo = env.SCHEMA ? 'SDL File' : `${cachedSchemas.length} Active Nodes`;
            
            return [
                `✨ SCHEMA EVOLVED (${duration}s)`,
                `📊 Source: ${sourceInfo}`,
                `🧬 Types: ${businessTypes.length}`,
                `---`,
                `The bridge has updated the graph model.`
            ].join('\n');
        }

        return `✅ Status: Schema stable (${businessTypes.length} types).`;

    } catch (error: any) {
        console.error(`[CRITICAL] Sync failure: ${error.message}`);
        throw error;
    } finally {
        isUpdating = false;
    }
}

// --- TOOLS IMPLEMENTATION ---
const toolHandlers = new Map<string, (args: any) => Promise<any>>();
const registeredToolsMetadata: any[] = [];

/**
 * Tool: query-graphql
 * Broadcasts queries to all nodes and merges results with universal deduplication.
 */
const queryGraphqlHandler = async ({ query, variables, headers }: { query: string, variables?: string, headers?: string }) => {
    try {
        const parsedQuery = parse(query);
        const hasMutation = parsedQuery.definitions.some(
            (def: any) => def.kind === "OperationDefinition" && def.operation === "mutation"
        );
        
        if (hasMutation && !env.ALLOW_MUTATIONS) {
            throw new Error("Mutation execution is blocked by ALLOW_MUTATIONS=false.");
        }
        
        const runtimeHeaders = headers ? JSON.parse(headers) : {};
        const fetchHeaders = { "Content-Type": "application/json", ...getEffectiveHeaders(), ...runtimeHeaders };
        const fetchVariables = variables ? (typeof variables === 'string' ? JSON.parse(variables) : variables) : undefined;

        const endpoints = env.ENDPOINT.split(',').map(url => url.trim());
        const executeResults = await Promise.allSettled(
            endpoints.map(async (url) => { 
                const response = await fetch(url, {
                    method: "POST",
                    headers: fetchHeaders,
                    body: JSON.stringify({ query, variables: fetchVariables }),
                    signal: AbortSignal.timeout(15000)
                });
                
                const result = await response.json();
                
                if (!response.ok && !result.errors) {
                    throw new Error(`Node ${url} returned status ${response.status}`);
                }
                
                return { url, data: result };
            })
        );

        const successes = executeResults
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
            .map(r => r.value);

        if (successes.length === 0) throw new Error("Execution failed on all available nodes.");

        const allErrors = successes.flatMap(s => s.data.errors || []);
        if (allErrors.length > 0) {
            return { 
                content: [{ 
                    type: "text" as const, 
                    text: `❌ GraphQL Validation/Execution Error:\n${JSON.stringify(allErrors, null, 2)}` 
                }], 
                isError: true 
            };
        }

        const mergedData: any = {};
        successes.forEach((resp) => {
            const nodeData = resp.data.data;
            if (!nodeData) return;

            Object.keys(nodeData).forEach(key => {
                if (Array.isArray(nodeData[key])) {
                    const existing = mergedData[key] || [];
                    const combined = [...existing, ...nodeData[key]];
                    mergedData[key] = Array.from(new Set(combined.map(v => JSON.stringify(v))))
                                          .map(s => JSON.parse(s));
                } else if (typeof nodeData[key] === 'object' && nodeData[key] !== null) {
                    mergedData[key] = { ...(mergedData[key] || {}), ...nodeData[key] };
                } else {
                    mergedData[key] = nodeData[key];
                }
            });
        });

        const cypherLogs = successes.flatMap(r => r.data.extensions?.cypher || []);
        const cleanCypher = cypherLogs.map((c: string) => 
            c.replace(/^CYPHER: /, '').replace(/^CYPHER 5\n/, '').replace(/\nPARAMS: \{\}$/, '')
        );

        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify({
                    meta: { nodes_queried: endpoints.length, nodes_responding: successes.length },
                    data: mergedData,
                    ...(cleanCypher.length > 0 ? { cypher_execution_plan: cleanCypher } : {})
                }, null, 2)
            }]
        };
    } catch (error: any) {
        return { content: [{ type: "text" as const, text: `❌ Execution error: ${error.message}` }], isError: true };
    }
};

toolHandlers.set("query-graphql", queryGraphqlHandler);
registerTool(
    server, 
    toolHandlers, 
    registeredToolsMetadata, 
    "query-graphql", 
    "Execute GraphQL operations (queries and mutations) against the federated system. " +
    "WARNING: This tool performs remote operations. 'Mutation' operations will modify persistent state; " +
    "execute these only when a state change is intended. " +
    "Prerequisites: Verify schema structure using 'introspect-schema' before executing complex queries. " +
    "Security: Inherits environment-based authentication. " +
    "Returns: A JSON object containing the execution result ('data') or a list of 'errors' in case of failure.",
    {
        query: z.string().describe("The GraphQL query or mutation string."),
        variables: z.string().optional().describe("JSON string of variables for the operation."),
        headers: z.string().optional().describe("JSON string of extra HTTP headers for the request."),
    }, 
    queryGraphqlHandler
);

/**
 * Tool: introspect-schema
 * Provides a global view of all nodes and resolves type conflicts.
 */
const introspectHandler = async ({ typeNames }: { typeNames?: string[] }) => {
    await getSchema(false);
    if (cachedSchemas.length === 0) {
        return { content: [{ type: "text" as const, text: "❌ System is not initialized." }] };
    }

    if (!typeNames || typeNames.length === 0) {
        const manifest = (global as any).nodeManifest || [];
        const body = manifest.map((m: any) => 
            `🌐 NODE: ${m.endpoint}\n   ACTIONS: ${m.availableMutations.join(', ') || 'none'}\n   ENTITIES: ${m.domainEntities.join(', ')}`
        ).join('\n\n');
        return { content: [{ type: "text" as const, text: `FEDERATED SCHEMA OVERVIEW\n\n${body}` }] };
    }

    const resolution: any = {};
    for (const name of typeNames) {
        const variants: any[] = [];
        for (const schema of cachedSchemas) {
            const found = introspectSpecificTypes(schema, [name]);
            if (found && found[name]) {
                variants.push({ origin: schema._originUrl, data: found[name] });
            }
        }

        if (variants.length === 0) continue;

        if (variants.length === 1) {
            resolution[name] = variants[0].data;
        } else {
            const baseline = JSON.stringify(variants[0].data);
            const allMatch = variants.every(v => JSON.stringify(v.data) === baseline);

            if (allMatch) {
                resolution[name] = variants[0].data;
            } else {
                variants.forEach((v, idx) => {
                    resolution[`${name}_from_node_${idx + 1}`] = {
                        ...v.data,
                        _meta: { origin_node: v.origin, conflict: "Structural difference detected across schemas" }
                    };
                });
            }
        }
    }

    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify(resolution, null, 2)
        }]
    };
};

toolHandlers.set("introspect-schema", introspectHandler);
registerTool(
    server, 
    toolHandlers, 
    registeredToolsMetadata, 
    "introspect-schema", 
    "Retrieve the full GraphQL schema and type definitions. " +
    "READ-ONLY: This tool is strictly non-destructive. It fetches schema metadata and performs internal conflict resolution " +
    "based on timestamps in memory. It does not modify, delete, or create data on the remote GraphQL endpoint. " +
    "Use this for initial discovery and schema analysis before calling 'query-graphql'. " +
    "Returns a structured JSON object containing type definitions and field specifications. " +
    "If 'typeNames' is provided, it restricts output to those specific types. " +
    "CAUTION: For large-scale schemas (e.g., GitHub GraphQL API or @neo4j/graphql models), the response may be truncated or empty " +
    "if requested without filtering. Always use 'typeNames' to target specific segments when working with complex production schemas.",
    {
        typeNames: z.array(z.string()).optional().describe("List of specific GraphQL type names to introspect. If omitted, the full schema is returned (use with caution on large APIs)."),
    }, 
    introspectHandler
);

// --- PROMPT REGISTRY ---
registerPrompt(server, "system-health", "Check status of all nodes", "Perform a simple __typename query on all endpoints.");

// --- HTTP ADAPTER FOR GRAPHIQL & SSE ---
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '', `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/graphiql')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(renderGraphiQL(`http://localhost:${env.MCP_PORT}/mcp`, env.HEADERS));
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let requestId: any = null;
            try {
                const payload = JSON.parse(body);

                if (!payload.method && payload.query) {
                    const handler = toolHandlers.get("query-graphql");
                    if (handler) {
                        const mcpResult = await handler({ 
                            query: payload.query, 
                            variables: payload.variables 
                        });
                        
                        const resultText = mcpResult.content[0].text;
                        if (mcpResult.isError || resultText.startsWith('❌')) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ errors: [{ message: resultText }] }));
                        }
                        const parsed = JSON.parse(resultText);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        const graphQLResponse = parsed.data ? parsed : { data: parsed };
                        return res.end(JSON.stringify(graphQLResponse));
                    }
                }

                const { method, id, params } = payload;
                requestId = id;

                const target = (method === "call-tool" || method === "tools/call") ? params.name : method;
                const args = (method === "call-tool" || method === "tools/call") ? params.arguments : params;

                const handler = toolHandlers.get(target);
                if (!handler) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ 
                        jsonrpc: '2.0', 
                        id: requestId, 
                        error: { code: -32601, message: `Method ${target} not found` } 
                    }));
                }

                const result = await handler(args);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
            } catch (e: any) {
                res.writeHead(500);
                res.end(JSON.stringify({ 
                    jsonrpc: '2.0', 
                    id: requestId, 
                    error: { message: e.message } 
                }));
            }
        });
        return;
    }
    res.writeHead(404);
    res.end("Not Found");
}

// --- SERVER LIFECYCLE ---
async function main() {
    const isInspector = !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT || process.env.INSPECTOR_URL);
    
    if (process.env.ENABLE_HTTP !== "false" && !isInspector) {
        const httpSrv = http.createServer(handleHttpRequest);
        httpSrv.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') console.error(`[ERROR] Port ${env.MCP_PORT} already in use.`);
        });

        httpSrv.listen(env.MCP_PORT, () => {
            console.error(`[SYSTEM] Federated Bridge v${getVersion()} active on port ${env.MCP_PORT}`);
            console.error(`📡 SSE Endpoint: http://localhost:${env.MCP_PORT}/mcp`);
            if (process.env.ENABLE_HTTP === "true") {
                console.error(`🎨 GraphiQL: http://localhost:${env.MCP_PORT}/graphiql`);
            }
        });
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    getSchema(true).catch(err => console.error(`[BOOT-WARN] Initial sync failed: ${err.message}`));
}

process.on('SIGINT', () => { console.error('[SYSTEM] Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

main().catch(err => {
    console.error(`[FATAL] Startup failed: ${err.message}`);
    process.exit(1);
});