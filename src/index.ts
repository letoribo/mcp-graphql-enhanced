#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse } from "graphql/language";
import z from "zod";
import { renderGraphiQL} from "./helpers/graphiql.js";
import { 
    isObjectType, 
    getNamedType, 
    GraphQLField,
    GraphQLSchema
} from "graphql";

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
        return "3.6.0";
    }
};

checkDeprecatedArguments();

/**
 * Environment configuration schema
 */
const EnvSchema = z.object({
    NAME: z.string().default("mcp-graphql-enhanced"),
    ENDPOINT: z.preprocess(
        (val: unknown) => {
            if (typeof val === 'string') {
                // Support for multiple endpoints via comma-separated string
                return val.trim();
            }
            return val;
        },
        z.string().min(1) 
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
                return !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT || process.env.MCP_PORT);
            }
            return value === "true";
        })
        .default("auto"),
});

const env = EnvSchema.parse(process.env);

const server = new McpServer({
    name: env.NAME,
    version: getVersion(),
    description: "Unified GraphQL-to-MCP bridge with dynamic schema support."
}, {
    capabilities: {
        prompts: {},
        tools: {}
    }
});

// --- CACHE STATE ---
let cachedSDL: string | null = null;
let cachedSchemaObject: any = null;
let schemaLoadError: Error | null = null;
let isUpdating = false;
let updatePromise: Promise<string> | null = null;
let lastKnownTypeCount = 0;

/**
 * Smart Hybrid Schema Fetcher
 * @param force If true, blocks and waits for the new schema evolution.
 * If false, returns cache immediately and updates in background.
 */
async function getSchema(force: boolean = false, requestedTypes?: string[]): Promise<string> {
    // 1. Hook into existing update if in progress
    if (isUpdating && updatePromise) {
        if (force || !cachedSDL) return await updatePromise;
        return cachedSDL;
    }

    // 2. Return cache if valid and not forcing
    if (cachedSDL && !force) {
        // Validation check: ensure requested types exist in current cache
        if (requestedTypes && cachedSchemaObject) {
            const typeMap = cachedSchemaObject.getTypeMap();
            const missing = requestedTypes.filter(t => !typeMap[t]);
            if (missing.length > 0) {
                // Force a refresh if requested types are missing
                return await (updatePromise = performUpdate(true));
            }
        }
        return cachedSDL;
    }

    if (force) schemaLoadError = null;
    if (schemaLoadError) throw schemaLoadError;

    // 3. Trigger update
    updatePromise = performUpdate(force);
    
    try {
        if (force || !cachedSDL) {
            await updatePromise; // Wait for update to complete
            return cachedSchemaObject;
        }
        return cachedSchemaObject;
    } finally {
        updatePromise = null;
    }
}

/**
 * Internal logic for schema introspection and building.
 * Optimized for Multi-Endpoint Broadcast: Uses the first available URL for discovery.
 */
async function performUpdate(force: boolean): Promise<string> {
    isUpdating = true;
    const startTime = Date.now();

    try {
        const { buildClientSchema, getIntrospectionQuery, printSchema, buildASTSchema, parse: gqlParse, isObjectType } = require("graphql");

        let tempSchema: any;

        // --- FETCHING LOGIC ---
        if (env.SCHEMA) {
            let sdl: string;
            if (env.SCHEMA.startsWith("http")) {
                // Remote SDL File
                const response = await fetch(env.SCHEMA);
                if (!response.ok) throw new Error(`Remote_SDL_Fetch_Failed: ${response.statusText}`);
                sdl = await response.text();
            } else {
                // Local SDL File via helper
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            tempSchema = buildASTSchema(gqlParse(sdl));
        } else {
            // --- BROADCAST ADAPTATION ---
            // Extract the primary endpoint for introspection
            const endpoints = env.ENDPOINT.split(',').map(url => url.trim());
            const primaryEndpoint = endpoints[0];

            // Execute Introspection against the primary target
            const response = await fetch(primaryEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...env.HEADERS },
                body: JSON.stringify({ query: getIntrospectionQuery() }),
            });

            if (!response.ok) throw new Error(`HTTP_${response.status} at ${primaryEndpoint}: ${response.statusText}`);
            const result = await response.json();
            if (!result.data) throw new Error("Invalid GraphQL response: Missing 'data' field.");
            
            tempSchema = buildClientSchema(result.data);
        }

        // --- UNIFIED STRUCTURAL ANALYSIS ---
        const typeMap = tempSchema.getTypeMap();
        
        // Filter domain types while ignoring internal system scalars and types
        const businessTypes = Object.keys(typeMap).filter(typeName => {
            const type = typeMap[typeName];
            return (
                !typeName.startsWith('__') && 
                !['Query', 'Mutation', 'Subscription'].includes(typeName) &&
                !['String', 'Int', 'Float', 'Boolean', 'ID', 'BigInt', 'DateTime'].includes(typeName) &&
                isObjectType(type)
            );
        });

        lastKnownTypeCount = businessTypes.length;
        const currentSDL = printSchema(tempSchema);

        // Always update the live object upon successful build
        cachedSchemaObject = tempSchema; 

        if (currentSDL !== cachedSDL) {
            cachedSDL = currentSDL;
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const endpointLabel = env.SCHEMA ? 'Local/Remote SDL' : `Live Broadcast Node (${env.ENDPOINT.split(',').length} targets)`;
            
            return [
                `✨ SCHEMA EVOLVED (${duration}s)`,
                `📊 Source: ${endpointLabel}`,
                `🧬 Labels: ${businessTypes.join(', ') || 'None'}`,
                `---`,
                `The bridge has updated the graph model. New types are now queryable.`
            ].join('\n');
        } else {
            return `✅ Status: Schema stable (${lastKnownTypeCount} labels).`;
        }

    } catch (error: any) {
        return [
            `❌ SCHEMA SYNC FAILED`,
            `🔍 Reason: ${error.message}`,
            `🛠️ Action: Verify your connection and retry.`
        ].join('\n');
    } finally {
        isUpdating = false;
        updatePromise = null;
    }
}

// --- TOOL REGISTRY ---
const toolHandlers = new Map<string, (args: any) => Promise<any>>();
const registeredToolsMetadata: any[] = [];

/** 
 * History buffer for the last 5 operations to support debugging and visualization.
 */
let executionLogs: Array<{
    query: string;
    variables: any;
    response: any;
    timestamp: string;
}> = [];

/**
 * Tool: query-graphql
 * Handles query broadcast and execution across multiple endpoints.
 */
const queryGraphqlHandler = async ({ query, variables, headers }: { query: string, variables?: string, headers?: string }) => {
    try {
        const parsedQuery = parse(query);
        const isMutation = parsedQuery.definitions.some(
            (def: any) => def.kind === "OperationDefinition" && def.operation === "mutation",
        );
        
        if (isMutation && !env.ALLOW_MUTATIONS) {
            throw new Error("Mutations are not allowed.");
        }
        
        const toolHeaders = headers ? JSON.parse(headers) : {};
        const allHeaders = { "Content-Type": "application/json", ...env.HEADERS, ...toolHeaders };
        let parsedVariables = variables;
        if (typeof variables === 'string') parsedVariables = JSON.parse(variables);

        // Split multiple endpoints for broadcast
        const endpoints = env.ENDPOINT.split(',').map(url => url.trim());

        // Execute parallel requests to all targets
        const settleResults = await Promise.allSettled(
            endpoints.map(async (url) => { 
                console.error(`[QUERY] Sending to ${url}`);
                const response = await fetch(url, {
                    method: "POST",
                    headers: allHeaders,
                    body: JSON.stringify({ query, variables: parsedVariables }),
                    signal: AbortSignal.timeout(5000) // 5s timeout protection
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} from ${url}`);
                }

                return {
                    url,
                    data: await response.json()
                };
            })
        );

        const successfulResponses = settleResults
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
            .map(r => r.value);

        const failedResponses = settleResults
            .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
            .map(r => r.reason.message || r.reason);

        if (successfulResponses.length === 0) {
            throw new Error(`All endpoints failed: ${failedResponses.join('; ')}`);
        }

        const primaryData = successfulResponses[0].data;

        // 1. Extract and sanitize Cypher from the primary response
        const rawCypher = primaryData.extensions?.cypher || [];
        const cleanCypher = rawCypher.map((c: string) => 
            c.replace(/^CYPHER: /, '')
             .replace(/^CYPHER 5\n/, '')
             .replace(/\nPARAMS: \{\}$/, '')
        );

        // 2. Update execution history buffer
        executionLogs.push({
            query,
            variables: parsedVariables,
            response: primaryData, 
            timestamp: new Date().toISOString()
        });
        if (executionLogs.length > 5) executionLogs.shift();

        // 3. Optimized response for MCP client
        const responseForClaude: any = {
            status: {
                total: endpoints.length,
                success: successfulResponses.length,
                failed: failedResponses.length
            },
            result: primaryData.data,
            ...(cleanCypher.length > 0 ? { cypher: cleanCypher } : {}),
            ...(failedResponses.length > 0 ? { warnings: failedResponses } : {})
        };

        return { 
            content: [{ 
                type: "text" as const, 
                text: JSON.stringify(responseForClaude, null, 2) 
            }] 
        };
    } catch (error: any) {
        throw new Error(`Execution failed: ${error.message}`);
    }
};

toolHandlers.set("query-graphql", queryGraphqlHandler);
registerTool(
    server,
    toolHandlers,
    registeredToolsMetadata,
    "query-graphql",
    "Execute a GraphQL query against the endpoint",
    {
        query: z.string(),
        variables: z.string().optional(),
        headers: z.string().optional(),
    },
    queryGraphqlHandler
);

/**
 * Tool: introspect-schema
 * Provides schema exploration with built-in agent recovery logic.
 */
const introspectHandler = async ({ typeNames }: { typeNames?: string[] }) => {
    const result = await getSchema(true); 

    if (!result || typeof result === 'string') {
        return {
            content: [{
                type: "text" as const,
                text: `❌ SCHEMA_ERROR: ${typeof result === 'string' ? result : 'GraphQL schema is not initialized yet.'}\n` +
                      `ACTION: Please wait 5-10 seconds for the backend endpoint to respond.`
            }]
        };
    }

    const schema = result as GraphQLSchema;
    const typeMap = schema.getTypeMap();
    const queryType = schema.getQueryType();
    const queryFields = queryType ? queryType.getFields() : {};
    const mutationType = schema.getMutationType();
    const mutationFields = mutationType ? mutationType.getFields() : {};

    // Gap analysis for requested types
    if (typeNames && typeNames.length > 0) {
        const missing = typeNames.filter(name => {
            const existsAsType = !!typeMap[name];
            const existsAsMutation = !!mutationFields[name];
            const existsAsQueryField = !!queryFields[name]; 
            return !existsAsType && !existsAsMutation && !existsAsQueryField;
        });
        
        if (missing.length > 0) {
            const internalTypes = ['Query', 'Mutation', 'Subscription'];
            const availableEntities = Object.keys(typeMap).filter(
                t => !t.startsWith('__') && !internalTypes.includes(t)
            );
            
            const schemaVersion = `v${availableEntities.length}.${Math.floor(Date.now() / 10000) % 1000}`;

            return {
                content: [{
                    type: "text" as const,
                    text: `❌ PARTIAL RESULTS [Schema ID: ${schemaVersion}]\n\n` +
                          `MISSING ENTITIES: ${missing.join(", ")}\n` +
                          `REASON: Requested entities not found.\n` +
                          `ACTION: Re-examine available types below.\n\n` +
                          `AVAILABLE_ENTITIES: ${availableEntities.join(", ")}`
                }]
            };
        }
    }

    // Return general manifest if no specific types requested
    if (!typeNames || typeNames.length === 0) {
        const discoveredEntities = new Set<string>();
        
        if (queryType) {
            const fields = queryType.getFields() as Record<string, GraphQLField<any, any>>;
            Object.values(fields).forEach((field) => {
                const namedType = getNamedType(field.type);
                if (isObjectType(namedType) && !namedType.name.startsWith('__')) {
                    discoveredEntities.add(namedType.name);
                }
            });
        }

        const entryPoints = Array.from(discoveredEntities).sort();
        const allTypes = Object.keys(typeMap).filter(t => !t.startsWith('__'));
        const schemaVersion = `v${allTypes.length}.${Math.floor(Date.now() / 10000) % 1000}`;

        return { 
            content: [{ 
                type: "text" as const, 
                text: `GraphQL Schema Manifest [ID: ${schemaVersion}]\n\n` +
                      `ENTRY_POINT_ENTITIES: ${entryPoints.join(", ") || "None"}\n` +
                      `TOTAL_SCHEMA_TYPES: ${allTypes.length}\n\n` +
                      `ALL_AVAILABLE_TYPES: ${allTypes.join(", ")}`
            }] 
        };
    }
    
    const filtered = introspectSpecificTypes(schema, typeNames);
    return { 
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] 
    };
};

toolHandlers.set("introspect-schema", introspectHandler);
registerTool(
    server,
    toolHandlers,
    registeredToolsMetadata,
    "introspect-schema",
    "Introspect the GraphQL schema with optional type filtering",
    {
        typeNames: z.array(z.string()).optional(),
    },
    introspectHandler
);

// --- PROMPTS ---
registerPrompt(
  server,
  "health-check",
  "Check if the GraphQL endpoint is alive",
  "Run 'query-graphql' with query '{ __typename }' to verify connection."
);

registerPrompt(
  server,
  "schema-overview",
  "List all available types",
  "Run 'introspect-schema' to see all types and entry points."
);

registerPrompt(
  server,
  "list-scalars",
  "List all scalar types",
  "Run 'introspect-schema' and identify all scalars in the schema."
);

// --- HTTP SERVER LOGIC ---
/**
 * Local HTTP server to support GraphiQL UI and SSE transport
 */
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    // Standard CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mcp-protocol-version, x-mcp-sdk-version');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url || '', `http://${req.headers.host}`);

    // Render GraphiQL UI
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/graphiql')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(renderGraphiQL(`http://localhost:6274/mcp`, env.HEADERS));
    }

    // Process MCP/GraphQL requests
    if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let requestId: any = null;
            try {
                const payload = JSON.parse(body);

                // Handle raw GraphQL queries (e.g., from Docs or Playground)
                if (!payload.method && payload.query) {
                    const handler = toolHandlers.get("query-graphql");
                    if (handler) {
                        const mcpResult = await handler({ query: payload.query, variables: payload.variables });
                        const parsed = JSON.parse(mcpResult.content[0].text);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        const graphQLResponse = parsed.result.data ? parsed.result : { data: parsed.result };
                        return res.end(JSON.stringify(graphQLResponse));
                    }
                }

                // Standard MCP JSON-RPC handling
                const { method, id, params } = payload;
                requestId = id;
                let targetMethod = method;
                let toolArgs = params;

                if (method === "call-tool" || method === "tools/call") {
                    targetMethod = params.name;
                    toolArgs = params.arguments;
                }

                const handler = toolHandlers.get(targetMethod);
                if (!handler) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ 
                        jsonrpc: '2.0', 
                        id: requestId, 
                        error: { code: -32601, message: `Tool ${targetMethod} not found` } 
                    }));
                }

                const result = await handler(toolArgs);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }));

            } catch (e: any) {
                console.error(`[HTTP-ERROR] ${e.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ 
                    jsonrpc: '2.0', 
                    id: requestId, 
                    error: { code: -32603, message: e.message } 
                }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
}

// --- STARTUP ---
async function main() {
    const isInspector = !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT);
    const isHttpExplicitlyEnabled = process.env.ENABLE_HTTP === "true";

    // Enable HTTP port by default unless explicitly disabled or in inspector mode
    if (process.env.ENABLE_HTTP !== "false" && !isInspector) {
        const serverHttp = http.createServer(handleHttpRequest);
        
        serverHttp.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') {
                console.error(`[HTTP-ERROR] Port ${env.MCP_PORT} is busy.`);
            }
        });

        serverHttp.listen(env.MCP_PORT, () => {
            console.error(`[SYSTEM] Server "${env.NAME}" v${getVersion()} active`);
            console.error(`🤖 MCP SSE: http://localhost:${env.MCP_PORT}/mcp`);

            if (isHttpExplicitlyEnabled) {
                console.error(`🎨 GraphiQL UI: http://localhost:${env.MCP_PORT}/graphiql`);
            }
        });
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Background schema initialization
    getSchema().catch(() => {});
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(error => {
    console.error(`[FATAL] ${error}`);
    process.exit(1);
});