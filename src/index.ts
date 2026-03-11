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

const getVersion = () => {
    try {
        const pkg = require("../package.json");
        return pkg.version;
    } catch {
        return "3.2.1";
    }
};

checkDeprecatedArguments();

const EnvSchema = z.object({
    NAME: z.string().default("mcp-graphql-enhanced"),
    ENDPOINT: z.preprocess(
        (val: unknown) => (typeof val === 'string' ? val.trim() : val),
        z.string().url()
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
    description: "Start of the #mcp-graphql-enhanced channel on GraphQL server. Join here: https://discord.com/channels/622115132221685760/1348633379555184640"
});

// --- CACHE STATE ---
let cachedSDL: string | null = null;
let cachedSchemaObject: any = null;
let schemaLoadError: Error | null = null;
let isUpdating = false;
let updatePromise: Promise<string> | null = null;
let lastKnownTypeCount = 0;
let expectEmptySchema = false; // Intent flag for intentional purges

/**
 * Smart Hybrid Schema Fetcher (Zero-Error Version)
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
        // Validation check: If user wants specific types but they aren't in the cache
        if (requestedTypes && cachedSchemaObject) {
            const typeMap = cachedSchemaObject.getTypeMap();
            const missing = requestedTypes.filter(t => !typeMap[t]);
            if (missing.length > 0) {
                // Force a refresh if requested types are missing from current cache
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
            return await updatePromise;
        } else {
            updatePromise.catch(err => console.error("[SCHEMA] Background update failed:", err));
            return cachedSDL;
        }
    } finally {
        // Promise reference is cleared inside performUpdate's 'finally' block
    }
}

/**
 * Internal logic for schema introspection and building.
 * This version uses universal business-type tracking and provides 
 * detailed diagnostic reports instead of generic error messages.
 */
async function performUpdate(force: boolean): Promise<string> {
    isUpdating = true;
    const startTime = Date.now();

    try {
        const { buildClientSchema, getIntrospectionQuery, printSchema, buildASTSchema, parse: gqlParse, isObjectType } = require("graphql");

        let tempSchema: any;

        // --- FETCHING LOGIC (Unified Source) ---
        if (env.SCHEMA) {
            let sdl: string;
            if (env.SCHEMA.startsWith("http")) {
                // Remote SDL File: Fetch via HTTP
                const response = await fetch(env.SCHEMA);
                if (!response.ok) throw new Error(`Remote_SDL_Fetch_Failed: ${response.statusText}`);
                sdl = await response.text();
            } else {
                // Local SDL File: Use your custom helper (readFile inside)
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            // Direct path: Convert raw SDL string to GraphQLSchema object
            tempSchema = buildASTSchema(gqlParse(sdl));
        } else {
            // Standard Path: Execute Introspection Query against live ENDPOINT
            const response = await fetch(env.ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...env.HEADERS },
                body: JSON.stringify({ query: getIntrospectionQuery() }),
            });

            if (!response.ok) throw new Error(`HTTP_${response.status}: ${response.statusText}`);
            const result = await response.json();
            if (!result.data) throw new Error("Invalid GraphQL response: Missing 'data' field.");
            
            // Build Schema object from introspection JSON
            tempSchema = buildClientSchema(result.data);
        }

        // --- UNIFIED STRUCTURAL ANALYSIS (For AI Report) ---
        const typeMap = tempSchema.getTypeMap();
        
        // Filter "Business Labels" (Nodes) while ignoring internal scalars/system types
        const businessTypes = Object.keys(typeMap).filter(typeName => {
            const type = typeMap[typeName];
            return (
                !typeName.startsWith('__') && 
                !['Query', 'Mutation', 'Subscription'].includes(typeName) &&
                !['String', 'Int', 'Float', 'Boolean', 'ID', 'BigInt', 'DateTime'].includes(typeName) &&
                isObjectType(type)
            );
        });

        // Maintain state for "Gap Analysis"
        lastKnownTypeCount = businessTypes.length;
        const currentSDL = printSchema(tempSchema);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        // --- CACHE & NOTIFICATION ---
        if (currentSDL !== cachedSDL) {
            cachedSDL = currentSDL;
            cachedSchemaObject = tempSchema; // Store the live Schema object for tool execution
            
            return [
                `✨ SCHEMA EVOLVED (${duration}s)`,
                `📊 Source: ${env.SCHEMA ? 'Local/Remote SDL' : 'Live Endpoint'}`,
                `🧬 Labels: ${businessTypes.join(', ') || 'None'}`,
                `---`,
                `The bridge has updated the graph model. New types are now queryable.`
            ].join('\n');
        } else {
            return `✅ Status: Schema stable (${lastKnownTypeCount} labels).`;
        }

    } catch (error: any) {
        // Informative error report to prevent "AI confusion"
        return [
            `❌ SCHEMA SYNC FAILED`,
            `🔍 Reason: ${error.message}`,
            `🛠️ Action: Verify your ${env.SCHEMA ? 'file path' : 'endpoint connection'} and retry.`
        ].join('\n');
    } finally {
        isUpdating = false;
        updatePromise = null;
    }
}

// --- TOOL REGISTRY ---
const toolHandlers = new Map<string, (args: any) => Promise<any>>();

// This will store schemas for our dynamic HTTP 'list-tools' response
const registeredToolsMetadata: any[] = [];

/**
 * Helper to register tools in both MCP Server and our local registry
 * Handles both plain objects and Zod schemas
 */
function registerTool(
    name: string,
    description: string,
    schema: any, 
    handler: (args: any) => Promise<any>
) {
    // 1. Register in official MCP Server
    server.tool(name, description, schema, handler);

    // 2. Save handler for our HTTP routing
    toolHandlers.set(name, handler);

    // 3. Store metadata for dynamic Discovery
    // We treat 'schema' as a plain object for the JSON output
    registeredToolsMetadata.push({
        name,
        description,
        inputSchema: {
            type: "object",
            properties: Object.fromEntries(
                Object.entries(schema).map(([key, value]: [string, any]) => {
                    // Detect type from Zod or default to string
                    const typeName = value?._def?.typeName 
                        ? value._def.typeName.replace('Zod', '').toLowerCase() 
                        : "string";
                    return [key, { type: typeName }];
                })
            ),
            // Assume all fields in the object are required unless specified
            required: Object.keys(schema).filter(key => {
                const val = schema[key] as any;
                return val?._def?.typeName !== 'ZodOptional' && !key.includes('?');
            })
        }
    });
}

/** * executionLogs stores the last 5 GraphQL operations.
 * This allows the AI to "inspect" its own generated queries and the raw data 
 * for debugging or bridging to 3D visualization tools.
 */
let executionLogs: Array<{
    query: string;
    variables: any;
    response: any;
    timestamp: string;
}> = [];

// Tool: query-graphql
const queryGraphqlHandler = async ({ query, variables, headers }: { query: string, variables?: string, headers?: string }) => {
    try {
        const parsedQuery = parse(query);
        const isMutation = parsedQuery.definitions.some(
            (def: any) => def.kind === "OperationDefinition" && def.operation === "mutation",
        );
        if (isMutation && !env.ALLOW_MUTATIONS) throw new Error("Mutations are not allowed.");
        
        const toolHeaders = headers ? JSON.parse(headers) : {};
        const allHeaders = { "Content-Type": "application/json", ...env.HEADERS, ...toolHeaders };
        let parsedVariables = variables;
        if (typeof variables === 'string') parsedVariables = JSON.parse(variables);

        const response = await fetch(env.ENDPOINT, {
            method: "POST",
            headers: allHeaders,
            body: JSON.stringify({ query, variables: parsedVariables }),
        });

        const data = (await response.json()) as any;

        // 1. Extract and sanitize Cypher if present in extensions
        const rawCypher = data.extensions?.cypher || [];
        const cleanCypher = rawCypher.map((c: string) => 
            c.replace(/^CYPHER: /, '')
             .replace(/^CYPHER 5\n/, '')
             .replace(/\nPARAMS: \{\}$/, '')
        );

        // 2. Update execution history for internal server state
        executionLogs.push({
            query,
            variables: parsedVariables,
            response: data, 
            timestamp: new Date().toISOString()
        });
        if (executionLogs.length > 5) executionLogs.shift();

        // 3. Prepare optimized response for Claude
        const responseForClaude: any = {
            result: data.data,
            // Only add the cypher field if there's actual data to show
            ...(cleanCypher.length > 0 ? { cypher: cleanCypher } : {})
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
    "query-graphql",
    "Execute a GraphQL query against the endpoint",
    {
        query: z.string(),
        variables: z.string().optional(),
        headers: z.string().optional(),
    },
    queryGraphqlHandler
);

// Tool: introspect-schema
const introspectHandler = async ({ typeNames }: { typeNames?: string[] }) => {
    // 1. Always pull the latest schema state
    // The report from performUpdate is captured to show evolution details
    const evolutionSummary = await getSchema(true);
    
    const schema: GraphQLSchema = cachedSchemaObject; 
    const typeMap = schema.getTypeMap();

    // 2. Generate a structural fingerprint
    const typeKeys = Object.keys(typeMap).filter(t => !t.startsWith('__'));
    const schemaVersion = `v${typeKeys.length}.${Math.floor(Date.now() / 10000) % 1000}`;

    // --- GAP ANALYSIS: Check if requested types are actually in the map ---
    if (typeNames && typeNames.length > 0) {
        const missing = typeNames.filter(name => !typeMap[name]);
        
        if (missing.length > 0) {
            return {
                content: [{
                    type: "text" as const,
                    text: `❌ PARTIAL RESULTS [ID: ${schemaVersion}]\n\n` +
                          `MISSING TYPES: ${missing.join(", ")}\n` +
                          `REASON: The database has been updated, but the GraphQL Schema is still regenerating these specific types.\n` +
                          `ACTION: Please wait 3 seconds and retry 'introspect-schema' to see the full graph.\n\n` +
                          `CURRENTLY AVAILABLE: ${typeKeys.filter(t => !['Query', 'Mutation', 'Report'].includes(t)).join(", ")}`
                }]
            };
        }
    }

    if (!typeNames || typeNames.length === 0) {
        const queryType = schema.getQueryType();
        const discoveredEntities = new Set<string>();
        
        if (queryType) {
            const queryFields: Record<string, GraphQLField<any, any>> = queryType.getFields();
            Object.values(queryFields).forEach((field) => {
                const namedType = getNamedType(field.type);
                if (isObjectType(namedType) && !namedType.name.startsWith('__')) {
                    discoveredEntities.add(namedType.name);
                }
            });
        }

        const coreEntities = Array.from(discoveredEntities).sort();

        const communityHeader = [
            `🌐 Community Channel: #mcp-graphql-enhanced`,
            `🔗 Join the discussion: https://discord.com/channels/625400653321076807/1480510460339159184`,
            `---`
        ].join('\n');

        return { 
            content: [{ 
                type: "text" as const, 
                text: `${communityHeader}\n${evolutionSummary}\n\n` + // Include the report from performUpdate
                      `GraphQL Schema Manifest [ID: ${schemaVersion}]\n\n` +
                      `ENTRY_POINT_ENTITIES: ${coreEntities.join(", ") || "None"}\n` +
                      `TOTAL_SCHEMA_TYPES: ${typeKeys.length}\n\n` +
                      `ALL_AVAILABLE_TYPES: ${typeKeys.join(", ")}`
            }] 
        };
    }
    
    // 3. Detailed introspection for specific types
    const filtered = introspectSpecificTypes(schema, typeNames);
    return { 
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] 
    };
};

toolHandlers.set("introspect-schema", introspectHandler);
registerTool(
    "introspect-schema",
    "Introspect the GraphQL schema with optional type filtering",
    {
        typeNames: z.array(z.string()).optional(),
    },
    introspectHandler
);


// --- HTTP SERVER LOGIC ---
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    // Standard CORS headers for cross-origin compatibility
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') { 
        res.writeHead(204); 
        res.end(); 
        return; 
    }

    const url = new URL(req.url || '', `http://${req.headers.host}`);

    // Serve Web GUI (GraphiQL)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/graphiql')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(renderGraphiQL(env.ENDPOINT, env.HEADERS));
    }

    // Process MCP JSON-RPC Endpoint
    if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let requestId: any = null; // Defined early to be accessible in catch block
            
            try {
                const request = JSON.parse(body);
                const { method, id, params } = request;
                requestId = id;
                
                console.error(`[HTTP-RPC] Method: ${method} | ID: ${id}`);

                // --- DYNAMIC DISCOVERY ---
                if (method === "list-tools" || method === "tools/list") {
                    // Просто отдаем то, что накопили в нашем реестре при регистрации
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ 
                        jsonrpc: '2.0', 
                        id: requestId, 
                        result: { tools: registeredToolsMetadata } 
                    }));
                }

                // --- TOOL EXECUTION (CALL) ---
                let targetMethod = method;
                let toolArgs = params;

                // Support both direct calls and standard MCP "call-tool" structure
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

                // Execute the actual business logic for the tool
                const result = await handler(toolArgs);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    jsonrpc: '2.0', 
                    id: requestId, 
                    result 
                }));

            } catch (e: any) {
                console.error(`[HTTP-ERROR] ${e.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ 
                    jsonrpc: '2.0', 
                    id: requestId,
                    error: { code: -32603, message: e.message || "Internal Server Error" } 
                }));
            }
        });
        return;
    }
    
    // Health check endpoint for monitoring
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: "ok", server: env.NAME }));
    }

    // Default 404 for unknown paths
    res.writeHead(404);
    res.end("Not Found");
}

// --- STARTUP ---
async function main() {
    const rawEnableHttp = process.env.ENABLE_HTTP;
    
    // Determine if we should open the HTTP port.
    // 1. Check if we're not running inside the MCP Inspector.
    // 2. Ensure the user hasn't explicitly disabled HTTP (ENABLE_HTTP="false").
    const isInspector = !!(process.env.MCP_INSPECTOR || process.env.INSPECTOR_PORT);
    const shouldOpenPort = rawEnableHttp !== "false" && !isInspector;

    if (shouldOpenPort) {
        const serverHttp = http.createServer(handleHttpRequest);
        
        // Error handling to prevent crashes if the port is already in use
        serverHttp.on('error', (e: any) => {
            if (e.code !== 'EADDRINUSE') console.error(`[HTTP-ERROR] ${e.message}`);
        });

        serverHttp.listen(env.MCP_PORT, () => {
            // Log URLs only if HTTP is explicitly enabled
            if (env.ENABLE_HTTP === true) {
                console.error(`[HTTP] Server started on http://localhost:${env.MCP_PORT}`);
                console.error(`🎨 GraphiQL IDE: http://localhost:${env.MCP_PORT}/graphiql`);
            }
            console.error(`🤖 MCP Endpoint: http://localhost:${env.MCP_PORT}/mcp`);
        });
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Maintain quiet mode when running inside the Inspector to avoid protocol interference
    if (!isInspector) {
        console.error(`[STDIO] MCP Server "${env.NAME}" v${getVersion()} started`);
    }

    getSchema().catch(e => {
        if (!isInspector) console.error(`[SCHEMA] Warning: ${e.message}`);
    });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(error => {
    console.error(`[FATAL] ${error}`);
    process.exit(1);
});