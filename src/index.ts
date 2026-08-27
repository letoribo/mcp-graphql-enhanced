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
    getSafeIntrospectionOptions,
} from "./helpers/introspection.js";
import { registerTool } from "./helpers/tool-registry.js";
import { registerPrompt } from "./helpers/prompt-registry.js";
import { isQueryRelevantToNode } from "./helpers/routing.js";
import { isDocker } from "./helpers/container.js";
import path from "path";

/**
 * Retrieves the current version from package.json
 */
const getVersion = () => {
    try {
        const pkgPath = path.resolve(__dirname, "../package.json");
        const pkg = require(pkgPath);
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
            if (typeof val === 'string' && val.trim().length > 0) return val.trim();
            return undefined;
        },
        z.string().url("ENDPOINT must be a valid URL")
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
        (val: unknown) => {
            // Railway/Render dynamically assign the port via the PORT env var.
            // If set, we use it to ensure the HTTP server binds to the platform's expected interface.
            const port = process.env.PORT || val || 6274;
            return parseInt(port as string);
        },
        z.number().int().min(1024).max(65535)
    ).default(6274),
    ENABLE_HTTP: z
        .enum(["true", "false", "auto"])
        .transform((value: string) => {
            if (value === "auto") {
                return !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT || process.env.INSPECTOR_URL);
            }
            return value === "true";
        })
        .default("auto"),
});

const env = EnvSchema.parse(process.env);

/**
 * Build dynamic auth headers for nodes that require credentials
 */
function getEffectiveHeaders(): Record<string, string> {
    const rawHeaders = (typeof env.HEADERS === 'object' && env.HEADERS !== null) 
        ? (env.HEADERS as Record<string, string>) 
        : {};

    return {
        "User-Agent": `MCP-GraphQL-Enhanced/${getVersion()}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...rawHeaders
    };
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
async function getSchema(
    force: boolean = false, 
    requestedTypes?: string[], 
    typeDepth: number = 2
): Promise<string | GraphQLSchema> {
    if (isUpdating && updatePromise) {
        return await updatePromise;
    }

    if (cachedSchemaObject && !force) {
        if (requestedTypes && cachedSchemas.length > 0) {
            const allTypes = new Set(cachedSchemas.flatMap(s => Object.keys(s.getTypeMap())));
            const missing = requestedTypes.filter(t => !allTypes.has(t));
            if (missing.length > 0) return await performUpdate(true, typeDepth);
        }
        return cachedSchemaObject;
    }

    if (force) schemaLoadError = null;
    if (schemaLoadError) throw schemaLoadError;

    updatePromise = performUpdate(force, typeDepth);
    try {
        await updatePromise;
        return cachedSchemaObject;
    } finally {
        updatePromise = null;
    }
}

/**
 * Federated Update: Orchestrates introspection across all endpoints
 */
async function performUpdate(force: boolean, typeDepth: number = 2): Promise<string> {
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
                        headers: {
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            ...activeHeaders
                        },
                        body: JSON.stringify({ 
                            query: getIntrospectionQuery(getSafeIntrospectionOptions(typeDepth))
                        }),
                        keepalive: true
                    });
                    
                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`Status ${response.status}: ${errText.substring(0, 50)}`);
                    }
                    
                    const result = await response.json();
                    if (!result.data) return null;

                    const schemaInstance = buildClientSchema(result.data);
                    schemaInstance._originUrl = url;

                    const typeMap = schemaInstance.getTypeMap();
                    const mutationType = schemaInstance.getMutationType();
                    const rootTypes = new Set([
                        schemaInstance.getQueryType()?.name,
                        mutationType?.name,
                        schemaInstance.getSubscriptionType()?.name
                    ].filter(Boolean));

                    const entities = Object.keys(typeMap).filter(t => 
                        !t.startsWith('__') && !rootTypes.has(t)
                    );

                    const mutationFields = schemaInstance.getMutationType()?.getFields();
                    const mutationNames = mutationFields ? Object.keys(mutationFields) : [];

                    let capabilities: string[] = [];

                    if (env.ALLOW_MUTATIONS) {
                        capabilities = mutationNames.length > 0 ? mutationNames : ["Read Only"];
                    } else {
                        capabilities = ["Read Only (Writes Disabled)"];
                    }

                    manifest.push({
                        endpoint: url,
                        availableMutations: capabilities,
                        domainEntities: entities
                    });

                    return schemaInstance;
                } catch (e: any) {
                    console.error(`[SYNC-WARN] Failed to reach ${url}: ${e?.message || e}`);
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
        console.error(`[SYNC-WARN] Fetch failed:`, error?.message || error);
        if (error?.cause) {
            console.error(`[SYNC-WARN Cause]:`, error.cause);
        }
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
export const queryGraphqlHandler = async ({ 
    query, 
    variables, 
    headers, 
    endpoint,
    _request_meta 
}: { 
    query: string, 
    variables?: string, 
    headers?: string, 
    endpoint?: string,
    _request_meta?: { host: string }
}) => {
    // 🚀 Send event to the parent process (server.js / Electron)
    if (process.send) {
        process.send({
            type: 'MCP_TOOL_CALL',
            toolName: 'query-graphql',
            args: { query, variables, headers, endpoint }
        });
    }
    
    const host = _request_meta?.host || "unknown-host";
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

        if (endpoint && endpoint.trim().length > 0 && endpoint.trim() !== env.ENDPOINT) {
            env.ENDPOINT = endpoint.trim();
            cachedSchemas = [];
            await getSchema(true);
        }

        const manifest = (global as any).nodeManifest || [];
        
        const activeEndpointString = endpoint && endpoint.trim().length > 0 ? endpoint : env.ENDPOINT;
        const allEndpoints = activeEndpointString.split(',').map(url => url.trim());

        let endpoints = allEndpoints;

        if (allEndpoints.length > 1) {
            endpoints = allEndpoints.filter(url => {
                const nodeMeta = manifest.find((m: any) => m.endpoint === url);
                if (!nodeMeta) return true;
                return isQueryRelevantToNode(parsedQuery, nodeMeta);
            });
        }

        if (endpoints.length === 0) {
            throw new Error("None of the active endpoints support the requested query entities based on their manifests.");
        }

        const executeResults = await Promise.allSettled(
            endpoints.map(async (url) => { 
                let response: Response | null = null;
                let result: any = null;
                let lastError: any = null;

                // 🔄 If it's a cold start timeout (504/502), retry. Otherwise fail early.
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        response = await fetch(url, {
                            method: "POST",
                            headers: fetchHeaders,
                            body: JSON.stringify({ 
                                query, 
                                variables: { 
                                    ...fetchVariables,
                                    _proxyMeta: { host, source: "mcp-graphql-enhanced" } 
                                }
                            }),
                            signal: AbortSignal.timeout(15000)
                        });

                        if (response.ok) {
                            result = await response.json();
                            break;
                        }
                        
                        if (attempt === 0 && response.status >= 500) {
                            await new Promise(r => setTimeout(r, 800));
                            continue;
                        }

                        result = await response.json();
                        break;
                    } catch (err) {
                        lastError = err;
                        if (attempt === 0) {
                            await new Promise(r => setTimeout(r, 800));
                        }
                    }
                }

                if (!response && lastError) throw lastError;
                
                if (response && !response.ok && !result?.errors) {
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
        query: z.string().describe("The GraphQL query or mutation string. Example: 'query { guilds { id name } }'."),
        variables: z.string().optional().describe("JSON stringified object of variables. Example: '{\"id\": \"123\"}'."),
        headers: z.string().optional().describe("JSON stringified object of extra HTTP headers for the request."),
        endpoint: z.string().optional().describe("Optional target GraphQL HTTP/HTTPS URL to dynamically switch endpoint before execution."),
    }, 
    queryGraphqlHandler
);

/**
 * Tool: introspect-schema
 * Provides a global view of all nodes and resolves type conflicts.
 */
export const introspectHandler = async (args: { typeNames?: string[], typeDepth?: number, endpoint?: string }) => {
    // If endpoint is provided — temporarily override env.ENDPOINT for introspection
    if (args.endpoint && args.endpoint.trim().length > 0) {
        env.ENDPOINT = args.endpoint.trim();
        cachedSchemas = []; // reset schema cache
    }

    if (cachedSchemas.length === 0) {
        await getSchema(true); 
    }
    
    let { typeNames, typeDepth } = args;
    let cleanTypeNames: string[] | undefined;

    if (typeof typeNames === 'string') {
        try {
            const parsed = JSON.parse(typeNames);
            cleanTypeNames = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            cleanTypeNames = [typeNames];
        }
    } else if (Array.isArray(typeNames)) {
        cleanTypeNames = typeNames;
    }

    const hasTypeNames = cleanTypeNames !== undefined && cleanTypeNames.length > 0;
    const hasTypeDepth = typeDepth !== undefined;

    if (hasTypeDepth && !hasTypeNames) {
        return {
            content: [{
                type: "text",
                text: `⚠️ Security/Performance Limit:\n\n` +
                    `Applying 'typeDepth: ${typeDepth}' to the full schema is restricted to prevent context overflow and excessive load.\n\n` +
                    "Logic:\n" +
                    "1. 'typeDepth' controls the recursion limit for specific GraphQL types.\n" +
                    "2. Without 'typeNames', the tool defaults to 'Federated Manifest' mode, where depth control is not applicable.\n\n" +
                    "To fix: Either provide 'typeNames' to use the depth, or remove 'typeDepth' to view the manifest."
            }]
        };
    }

    const depth = typeDepth ?? 2;   
    await getSchema(false, cleanTypeNames, depth);

    if (cachedSchemas.length === 0) {
        return { content: [{ type: "text" as const, text: "❌ System is not initialized." }] };
    }

    if (!typeNames || typeNames.length === 0) {
        const manifest = (global as any).nodeManifest || [];
        const body = manifest.map((m: any) => {
            const capabilities = (Array.isArray(m.availableMutations) && m.availableMutations.length > 0) 
                ? m.availableMutations.join(', ') 
                : 'Read Only';

            return [
                `🌐 NODE: ${m.endpoint}`,
                `   CAPABILITIES: ${capabilities}`,
                `   ENTITIES: ${m.domainEntities.join(', ')}`
            ].join('\n');
        }).join('\n\n');
        
        return {
            content: [{ 
                type: "text" as const, 
                text: `FEDERATED SCHEMA OVERVIEW\n\n${body}` 
            }] 
        };
    }

    const resolution: any = {};
    for (const name of (cleanTypeNames || [])) {
        const variants: any[] = [];
        for (const schema of cachedSchemas) {
            const found = introspectSpecificTypes(schema, [name], depth); 
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

    // Un-comment for debugging typeDepth payload sizes in MCP clients:
    // if (typeNames) console.error(`[DEBUG] typeDepth: ${depth}, Response Length: ${JSON.stringify(resolution).length} bytes`);

    return {
        content: [{
            type: "text" as const,
            text: Object.keys(resolution).length > 0 
                ? JSON.stringify(resolution, null, 2) 
                : "No data found for requested types."
        }]
    };
};

toolHandlers.set("introspect-schema", introspectHandler);
registerTool(
    server, 
    toolHandlers, 
    registeredToolsMetadata, 
    "introspect-schema", 
    "Retrieve GraphQL schema details or system manifest. " +
    "READ-ONLY: Non-destructive metadata discovery. " +
    "Usage: " +
    "1. If 'typeNames' is provided: Returns the full SDL (Schema Definition Language) for the requested types, including fields and relations. " +
    "2. If 'typeNames' is omitted: Returns a Federated Manifest—a high-level summary of connected nodes, their capabilities, and available domain entities (not the full schema). " +
    "Use this to navigate the federated graph topology before executing queries.",
    {
        typeNames: z.array(z.string()).optional().describe(
            "List of specific GraphQL type names to introspect. " +
            "If provided, returns the detailed SDL definitions for these types. " +
            "If omitted, returns a system-wide Federated Manifest overview."
        ),
        typeDepth: z.number().optional().describe("Depth of nested fields to retrieve (default: 2)"),
        endpoint: z.string().optional().describe("Optional target GraphQL HTTP/HTTPS URL to dynamically switch endpoint before execution."),
    }, 
    introspectHandler
);

// --- PROMPT REGISTRY ---
registerPrompt(server, "system-health", "Check status of all nodes", "Perform a simple __typename query on all endpoints.");

let sessionMeta: Record<string, any> = {};

function updateSession(params: any) {
    if (params?._meta) {
        sessionMeta = { ...params._meta };
    }
}

function sendJsonResponse(res: ServerResponse, data: any, statusCode: number = 200) {
    const responseBody: any = { ...data };
    
    if (Object.keys(sessionMeta).length > 0) {
        responseBody._meta = sessionMeta;
    }

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
}

const readBody = (req: IncomingMessage): Promise<string> => 
    new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
    });

async function executeGraphQL(query: string, variables: any) {
    const handler = toolHandlers.get("query-graphql");
    if (!handler) {
        throw new Error("GraphQL handler not found");
    }

    const mcpResult = await handler({ query, variables });
    
    if (mcpResult.isError) {
        return { errors: [{ message: mcpResult.content[0].text }] };
    }

    const resultText = mcpResult.content[0].text;
    const parsed = JSON.parse(resultText);
    return parsed.data ? parsed : { data: parsed };
}    

// --- HTTP ADAPTER FOR GRAPHIQL & NATIVE GRAPHQL ---
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '', `http://${req.headers.host}`);

    if (req.method === 'GET') {
        switch (url.pathname) {
            case '/':
            case '/graphql':    
            case '/graphiql':
                res.writeHead(200, { 'Content-Type': 'text/html' });
                const host = req.headers.host || ''; 
                const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
                const endpoint = isLocal 
                    ? `http://localhost:${env.MCP_PORT}/mcp` 
                    : '/mcp';
                    
                return res.end(renderGraphiQL(endpoint, env.HEADERS));
            
            case '/health':
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'ok', version: getVersion() }));

            default:
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Not Found' }));
        }
    }

    if (req.method === 'POST') {
        const body = await readBody(req);

        switch (url.pathname) {
            case '/mcp':
                let payload: any;
                try { payload = JSON.parse(body); } 
                catch (e: any) { return sendJsonResponse(res, { jsonrpc: '2.0', error: { message: e.message } }, 500); }

                const { method, id, params } = payload;

                if (method === "initialize") {
                    return sendJsonResponse(res, {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: "2025-11-25",
                            capabilities: { tools: {}, prompts: {} },
                            serverInfo: { name: env.NAME, version: getVersion() }
                        }
                    });
                }

                if (method?.startsWith("notifications/")) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end();
                }

                if (method === "ping") {
                    return sendJsonResponse(res, { jsonrpc: '2.0', id, result: {} });
                }
                updateSession(payload.params);

                if (!payload.method && payload.query) {
                    const handler = toolHandlers.get("query-graphql");
                    if (handler) {
                        const mcpResult = await handler({ 
                            query: payload.query, 
                            variables: payload.variables 
                        });
                        
                        const resultText = mcpResult.content[0].text;
                        if (mcpResult.isError || resultText.startsWith('❌')) {
                            return sendJsonResponse(res, { errors: [{ message: resultText }] }, 400);
                        }

                        try {
                            const parsed = JSON.parse(resultText);
                            const graphQLResponse = parsed.data ? parsed : { data: parsed };
                            return sendJsonResponse(res, graphQLResponse);
                        } catch (e: any) {
                            return sendJsonResponse(res, { data: { result: resultText } });
                        }
                    }
                }

                if (method === "tools/list" || method === "list-tools") {
                    return sendJsonResponse(res, { 
                        jsonrpc: '2.0', 
                        id, 
                        result: { tools: registeredToolsMetadata } 
                    });
                }

                if (method === "prompts/list" || method === "list-prompts") {
                    return sendJsonResponse(res, {
                        jsonrpc: '2.0',
                        id,
                        result: { prompts: [] }
                    });
                }

                const target = (method === "call-tool" || method === "tools/call") ? params.name : method;
                const args = (method === "call-tool" || method === "tools/call") ? params.arguments : params;

                const handler = toolHandlers.get(target);
                if (!handler) {
                    return sendJsonResponse(res, { 
                        jsonrpc: '2.0', 
                        id, 
                        error: { code: -32601, message: `Method ${target} not found` } 
                    });
                }

                const requestHost = req.headers.host;
                const enrichedArgs = { 
                    ...args, 
                    _request_meta: { host: requestHost }
                };

                const result = await handler(enrichedArgs);
                
                return sendJsonResponse(res, { jsonrpc: '2.0', id, result });

            case '/':  
            case '/graphql':
            case '/graphiql':
                try {
                    const { query, variables } = JSON.parse(body);
                    const result = await executeGraphQL(query, variables);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'Invalid GraphQL request' }));
                }
                
            default:
                res.writeHead(404);
                return res.end(JSON.stringify({ error: 'Endpoint not found' }));
        }
    }
}

// --- SERVER LIFECYCLE ---
async function main() {
    const isInspector = !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT || process.env.INSPECTOR_URL);
    const shouldStartHttp = env.ENABLE_HTTP && !isInspector;

    // Attach STDIO when stdin is a piped stream (!isTTY)
    const isPipe = typeof process !== "undefined" && process.stdin && !process.stdin.isTTY;
    if (isPipe && !shouldStartHttp) {
        await server.connect(new StdioServerTransport());
        
        process.stdin.on('close', () => process.exit(0));
        process.stdin.on('end', () => process.exit(0));
    }
    
    if (shouldStartHttp) {
        const httpSrv = http.createServer(handleHttpRequest);
        
        const start = (port: number) => {
            httpSrv.removeAllListeners('error');
            httpSrv.removeAllListeners('listening');

            httpSrv.once('error', (e: any) => {
                if (e.code === 'EADDRINUSE') {
                    if (isDocker()) {
                        // Port incrementing is ineffective inside Docker due to fixed host mapping (-p)
                        console.error(`[FATAL] Port ${port} is already in use. Port fallback is disabled in Docker. Exiting...`);
                        process.exit(1);
                    } else {
                        // Running natively on host: fall back to the next available port
                        console.error(`[WARN] Port ${port} is in use. Trying ${port + 1}...`);
                        httpSrv.close(() => start(port + 1));
                    }
                } else {
                    console.error(`[FATAL] Server error: ${e.message}`);
                    process.exit(1);
                }
            });

            httpSrv.listen(port, '0.0.0.0', () => {
                const address = httpSrv.address();
                const actualPort = typeof address === 'object' && address ? address.port : port;
                console.error(`[SYSTEM] Federated Bridge active on port ${actualPort}`);
                console.error(`📡 MCP Endpoint: http://localhost:${actualPort}/mcp`);
                if (process.env.ENABLE_HTTP === "true") {
                    console.error(`🎨 GraphiQL: http://localhost:${actualPort}/graphiql`);
                }
            });
        };

        start(env.MCP_PORT);
    }

    console.error(`[BOOT] Initializing schema sync for: ${env.ENDPOINT}`);
    getSchema(true).catch(err => console.error(`[BOOT-WARN] Initial sync failed: ${err.message}`));
}

process.on('SIGINT', () => { console.error('[SYSTEM] Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

if (!("WebSocketPair" in globalThis) && !process.env.CF_PAGES) {
    // We check if main exists as a function in the scope before calling it
    const globalContext = globalThis as any;
    if (typeof globalContext.main === 'function') {
        globalContext.main().catch((err: any) => {
            console.error(`[FATAL] Startup failed: ${err.message}`);
            process.exit(1);
        });
    } else {
        // Fallback case: if main() was renamed or moved elsewhere in your file
        try {
            // @ts-ignore - Bypasses compiler strict-checks for local execution blocks
            if (typeof main === 'function') { main(); }
        } catch (e) {
            console.log("[SYSTEM] Running inside non-monolithic runtime boundary.");
        }
    }
}