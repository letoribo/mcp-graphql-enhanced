/**
 * Library entry: MCP tools, schema sync, and WHATWG HTTP adapter.
 * Mount `httpAdapter` from the package root; run the CLI via the package bin.
 */


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    buildClientSchema,
    buildSchema,
    getIntrospectionQuery,
    isObjectType,
    parse,
    printSchema,
    type GraphQLSchema,
} from "graphql";
import z from "zod";

// Helper imports
import {
    introspectLocalSchema,
    introspectSpecificTypes,
    getSafeIntrospectionOptions,
} from "./helpers/introspection.js";
import { registerTool } from "./helpers/tool-registry.js";
import { registerPrompt } from "./helpers/prompt-registry.js";
import { isQueryRelevantToNode } from "./helpers/routing.js";
import { createMcpHttpAdapter } from "./helpers/http-adapter.js";
export { createMcpHttpAdapter };
import { version } from "./version.js";

const runtimeEnv: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env
        ? (process.env as Record<string, string | undefined>)
        : {};

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
            const port = runtimeEnv.PORT || val || 6274;
            return parseInt(port as string);
        },
        z.number().int().min(1024).max(65535)
    ).default(6274),
    ENABLE_HTTP: z
        .enum(["true", "false", "auto"])
        .transform((value: string) => {
            if (value === "auto") {
                return !!(runtimeEnv.MCP_INSPECTOR || runtimeEnv.INSPECTOR_PORT || runtimeEnv.INSPECTOR_URL);
            }
            return value === "true";
        })
        .default("auto"),
    CORS_ORIGINS: z
        .string()
        .default("")
        .transform((val: string) =>
            val
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
        ),
});

export const env = EnvSchema.parse(runtimeEnv);

/**
 * Build dynamic auth headers for nodes that require credentials
 */
function getEffectiveHeaders(): Record<string, string> {
    const rawHeaders = (typeof env.HEADERS === 'object' && env.HEADERS !== null) 
        ? (env.HEADERS as Record<string, string>) 
        : {};

    return {
        "User-Agent": `MCP-GraphQL-Enhanced/${version}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...rawHeaders
    };
}

/**
 * Initialize MCP Server with full capabilities
 */
export const server = new McpServer({
    name: env.NAME,
    version,
    description: "Federated GraphQL-to-MCP bridge with broadcast introspection and full type visibility."
}, {
    capabilities: {
        prompts: {},
        tools: {}
    }
});

// --- SCHEMA STATE (keyed by endpoint + all effective headers) ---
type SchemaWithOrigin = GraphQLSchema & { _originUrl?: string };
type SchemaCacheEntry = {
    cachedSDL: string | null;
    cachedSchemaObject: any;
    cachedSchemas: SchemaWithOrigin[];
    schemaLoadError: Error | null;
    nodeManifest: any[];
};

const SCHEMA_CACHE_MAX_ENTRIES = 32;
const SCHEMA_INFLIGHT_MAX = 16;
const INTROSPECTION_FETCH_TIMEOUT_MS = 15_000;
const schemaCache = new Map<string, SchemaCacheEntry>();
const inflightUpdates = new Map<string, Promise<SchemaCacheEntry>>();

function headersFingerprint(headers: Record<string, string>): string {
    // Structural encoding avoids delimiter collisions (e.g. values containing "&" / "=").
    return JSON.stringify(
        Object.keys(headers)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
            .map((k) => [k.toLowerCase(), headers[k]]),
    );
}

function schemaCacheKey(
    endpoint: string,
    customHeaders?: Record<string, string>,
): string {
    const headers = { ...getEffectiveHeaders(), ...customHeaders };
    return `${endpoint.trim()}::${headersFingerprint(headers)}`;
}

function rememberSchemaEntry(key: string, entry: SchemaCacheEntry): void {
    // Refresh insertion order for a simple LRU eviction policy.
    schemaCache.delete(key);
    schemaCache.set(key, entry);
    while (schemaCache.size > SCHEMA_CACHE_MAX_ENTRIES) {
        const oldest = schemaCache.keys().next().value;
        if (oldest === undefined) break;
        schemaCache.delete(oldest);
    }
}

function getOrCreateSchemaEntry(key: string): SchemaCacheEntry {
    let entry = schemaCache.get(key);
    if (!entry) {
        entry = {
            cachedSDL: null,
            cachedSchemaObject: null,
            cachedSchemas: [],
            schemaLoadError: null,
            nodeManifest: [],
        };
        rememberSchemaEntry(key, entry);
    } else {
        rememberSchemaEntry(key, entry);
    }
    return entry;
}

/** Return a ready cache entry without starting introspection. */
function peekSchemaEntry(
    endpoint: string,
    customHeaders?: Record<string, string>,
): SchemaCacheEntry | null {
    const entry = schemaCache.get(schemaCacheKey(endpoint, customHeaders));
    return entry?.cachedSchemaObject ? entry : null;
}

/**
 * Coalesce in-flight schema loads by key, bound concurrent unique loads,
 * and ensure failed/finished keys are always removed from the map.
 */
async function scheduleSchemaUpdate(
    key: string,
    entry: SchemaCacheEntry,
    typeDepth: number,
    customHeaders: Record<string, string> | undefined,
    endpoint: string,
): Promise<SchemaCacheEntry> {
    const existing = inflightUpdates.get(key);
    if (existing) {
        return await existing;
    }

    if (inflightUpdates.size >= SCHEMA_INFLIGHT_MAX) {
        throw new Error(
            `Too many concurrent schema loads (${SCHEMA_INFLIGHT_MAX}); retry after in-flight work completes.`,
        );
    }

    const promise = performUpdate(entry, typeDepth, customHeaders, endpoint);
    inflightUpdates.set(key, promise);
    try {
        const updated = await promise;
        rememberSchemaEntry(key, updated);
        return updated;
    } catch (error) {
        schemaCache.delete(key);
        throw error;
    } finally {
        inflightUpdates.delete(key);
    }
}

/**
 * Schema Fetcher with dependency tracking.
 * In-flight work and cache entries are keyed by endpoint + all effective headers
 * so concurrent shared-gateway requests cannot share the wrong schema.
 */
export async function getSchema(
    force: boolean = false,
    requestedTypes?: string[],
    typeDepth: number = 2,
    customHeaders?: Record<string, string>,
    endpointOverride?: string,
): Promise<SchemaCacheEntry> {
    const endpoint = (endpointOverride?.trim() || env.ENDPOINT).trim();
    const key = schemaCacheKey(endpoint, customHeaders);
    const entry = getOrCreateSchemaEntry(key);

    const inflight = inflightUpdates.get(key);
    if (inflight) {
        return await inflight;
    }

    if (entry.cachedSchemaObject && !force) {
        if (requestedTypes && entry.cachedSchemas.length > 0) {
            const allTypes = new Set(
                entry.cachedSchemas.flatMap((s) => Object.keys(s.getTypeMap())),
            );
            const missing = requestedTypes.filter((t) => !allTypes.has(t));
            if (missing.length > 0) {
                return scheduleSchemaUpdate(
                    key,
                    entry,
                    typeDepth,
                    customHeaders,
                    endpoint,
                );
            }
        }
        return entry;
    }

    if (force) entry.schemaLoadError = null;
    // Failed loads are not retained in the cache; if one slipped through, drop it and retry.
    if (entry.schemaLoadError) {
        schemaCache.delete(key);
    }

    const freshEntry = getOrCreateSchemaEntry(key);
    return scheduleSchemaUpdate(
        key,
        freshEntry,
        typeDepth,
        customHeaders,
        endpoint,
    );
}

/**
 * Federated Update: Orchestrates introspection across all endpoints
 */
async function performUpdate(
    entry: SchemaCacheEntry,
    typeDepth: number = 2,
    customHeaders?: Record<string, string>,
    endpoint: string = env.ENDPOINT,
): Promise<SchemaCacheEntry> {
    const startTime = Date.now();

    try {
        let tempSchemas: any[] = [];
        const manifest: any[] = [];

        const activeHeaders = {
            ...getEffectiveHeaders(),
            ...customHeaders
        };

        // --- FETCHING LOGIC: LOCAL SDL OR REMOTE BROADCAST ---
        if (env.SCHEMA) {
            let sdl: string;
            if (env.SCHEMA.startsWith("http")) {
                const response = await fetch(env.SCHEMA, {
                    signal: AbortSignal.timeout(INTROSPECTION_FETCH_TIMEOUT_MS),
                });
                if (!response.ok) throw new Error(`Remote_SDL_Fetch_Failed: ${response.statusText}`);
                sdl = await response.text();
            } else {
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            const localSchema = buildSchema(sdl) as SchemaWithOrigin;
            localSchema._originUrl = "local-sdl";
            tempSchemas = [localSchema];
            
            manifest.push({
                endpoint: "Local SDL File",
                availableMutations: ["*"],
                domainEntities: Object.keys(localSchema.getTypeMap()).filter(t => !t.startsWith('__'))
            });
        } else {
            const endpoints = endpoint.split(',').map(url => url.trim());
            
            const results = await Promise.all(endpoints.map(async (url) => {
                try {
                    // Helper to execute introspection query
                    const fetchIntrospection = async (options?: any, useMinimalQuery = false) => {
                        try {
                            const queryStr = useMinimalQuery 
                                ? `query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name } types { ...FullType } directives { name description locations args { ...InputValue } } } } fragment FullType on __Type { kind name description fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason } inputFields { ...InputValue } interfaces { ...TypeRef } enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason } possibleTypes { ...TypeRef } } fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue } fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }`
                                : getIntrospectionQuery(options);

                            const cleanHeaders: Record<string, string> = {
                                "Content-Type": "application/json",
                                "Accept": "application/json"
                            };

                            if (activeHeaders) {
                                for (const [k, v] of Object.entries(activeHeaders)) {
                                    if (!['host', 'content-length', 'connection'].includes(k.toLowerCase())) {
                                        cleanHeaders[k] = String(v);
                                    }
                                }
                            }

                            // 1. Attempt POST request
                            let res = await fetch(url, {
                                method: "POST",
                                headers: cleanHeaders,
                                body: JSON.stringify({ query: queryStr }),
                                signal: AbortSignal.timeout(INTROSPECTION_FETCH_TIMEOUT_MS),
                            });

                            // 2. GET Fallback (specifically for fragile serverless endpoints like SWAPI Netlify)
                            if (!res.ok) {
                                console.warn(`[SYNC-WARN] POST returned HTTP ${res.status} from ${url}. Retrying with GET fallback...`);
                                const getUrl = `${url}?query=${encodeURIComponent(queryStr.replace(/\s+/g, ' ').trim())}`;
                                res = await fetch(getUrl, {
                                    method: "GET",
                                    headers: { "Accept": "application/json" },
                                    signal: AbortSignal.timeout(INTROSPECTION_FETCH_TIMEOUT_MS),
                                });
                            }

                            if (!res.ok) {
                                console.error(`[SYNC-WARN] HTTP ${res.status} from ${url}`);
                                return null;
                            }

                            const json: any = await res.json();
                            
                            if (json?.errors?.length) {
                                console.error(`[SYNC-WARN] GraphQL errors from ${url}:`, json.errors[0]?.message);
                                return null;
                            }

                            if (!json?.data) {
                                console.error(`[SYNC-WARN] No data in response from ${url}`);
                                return null;
                            }

                            return json.data;
                        } catch (err: any) {
                            console.error(`[SYNC-WARN] Fetch attempt failed for ${url}:`, err?.message || err);
                            return null;
                        }
                    };

                    // --- MAIN INTROSPECTION FLOW ---

                    // 1. Attempt with expanded options
                    let introspectionData = await fetchIntrospection(getSafeIntrospectionOptions(typeDepth));

                    // 2. Fallback 1: Standard query without special parameters
                    if (!introspectionData) {
                        console.error(`[SYNC-INFO] Retrying ${url} with standard introspection query...`);
                        introspectionData = await fetchIntrospection();
                    }

                    // 3. Fallback 2: Minimal GraphQL v14 query + GET support
                    if (!introspectionData) {
                        console.error(`[SYNC-INFO] Retrying ${url} with minimal GraphQL v14 query...`);
                        introspectionData = await fetchIntrospection(undefined, true);
                    }

                    // Guard block: If all variants failed, return null and do not call buildClientSchema
                    if (!introspectionData) {
                        console.error(`[SYNC-WARN] Skipping ${url}: Unable to fetch valid introspection data.`);
                        return null;
                    }

                    const schemaInstance = buildClientSchema(introspectionData) as SchemaWithOrigin;
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

        entry.cachedSchemas = tempSchemas;
        entry.nodeManifest = manifest;
        entry.cachedSchemaObject = entry.cachedSchemas[0];
        const currentSDL = printSchema(entry.cachedSchemaObject);

        const typeMap = entry.cachedSchemaObject.getTypeMap();
        const businessTypes = Object.keys(typeMap).filter(typeName => {
            const type = typeMap[typeName];
            return !typeName.startsWith('__') && 
                   !['Query', 'Mutation', 'Subscription'].includes(typeName) &&
                   isObjectType(type);
        });

        if (currentSDL !== entry.cachedSDL) {
            entry.cachedSDL = currentSDL;
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const sourceInfo = env.SCHEMA ? 'SDL File' : `${entry.cachedSchemas.length} Active Nodes`;
            console.error([
                `✨ SCHEMA EVOLVED (${duration}s)`,
                `📊 Source: ${sourceInfo}`,
                `🧬 Types: ${businessTypes.length}`,
                `---`,
                `The bridge has updated the graph model.`
            ].join('\n'));
        }

        return entry;

    } catch (error: any) {
        console.error(`[SYNC-WARN] Fetch failed:`, error?.message || error);
        if (error?.cause) {
            console.error(`[SYNC-WARN Cause]:`, error.cause);
        }
        entry.schemaLoadError = error instanceof Error ? error : new Error(String(error));
        throw error;
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
    _request_meta?: { host?: string | null; waitUntil?: (promise: Promise<void> | void) => void }
}) => {
    if (typeof process !== "undefined" && typeof process.send === "function") {
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
        const fetchVariables = variables ? (typeof variables === 'string' ? JSON.parse(variables) : variables) : undefined;

        const activeEndpoint =
            endpoint && endpoint.trim().length > 0 ? endpoint.trim() : env.ENDPOINT;

        // Use a cached manifest immediately when available. Kick schema sync in
        // the background so hanging/disabled introspection cannot delay the query.
        // Prefer whatwg-node / Workers waitUntil so the runtime keeps the process
        // (or isolate) alive until sync settles; fall back to fire-and-forget.
        const schemaEntry = peekSchemaEntry(activeEndpoint, runtimeHeaders);
        const schemaSync = getSchema(
            false,
            undefined,
            2,
            runtimeHeaders,
            activeEndpoint,
        ).then(
            () => undefined,
            (schemaErr: any) => {
                console.error(
                    `[QUERY-WARN] Background schema sync failed: ${schemaErr?.message || schemaErr}`,
                );
            },
        );
        if (_request_meta?.waitUntil) {
            _request_meta.waitUntil(schemaSync);
        } else {
            void schemaSync;
        }

        const manifest = schemaEntry?.nodeManifest || [];
        const allEndpoints = activeEndpoint.split(',').map(url => url.trim());

        let endpoints = allEndpoints;
        if (allEndpoints.length > 1 && manifest.length > 0) {
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

                // 🛡️ GUARANTEED Apollo CSRF & JSON headers
                const cleanHeaders: Record<string, string> = {
                    "content-type": "application/json",
                    "accept": "application/json",
                    "apollo-require-preflight": "true",
                    "x-apollo-operation-name": "MCPQuery"
                };

                // Merge headers from environment and runtime without overwriting CSRF protection
                const mergedCustomHeaders = { ...getEffectiveHeaders(), ...runtimeHeaders };
                for (const [k, v] of Object.entries(mergedCustomHeaders)) {
                    const lowerKey = k.toLowerCase();
                    if (!['host', 'content-length', 'connection'].includes(lowerKey)) {
                        cleanHeaders[lowerKey] = String(v);
                    }
                }

                const payloadVariables = fetchVariables 
                    ? { ...fetchVariables, _proxyMeta: { host, source: "mcp-graphql-enhanced" } }
                    : undefined;

                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        response = await fetch(url, {
                            method: "POST",
                            headers: cleanHeaders,
                            body: JSON.stringify({ 
                                query, 
                                ...(payloadVariables ? { variables: payloadVariables } : {})
                            }),
                            signal: AbortSignal.timeout(15000)
                        });

                        // GET Fallback on HTTP 400
                        if (!response.ok && response.status === 400) {
                            const minifiedQuery = query.replace(/\s+/g, ' ').trim();
                            let getUrl = `${url}?query=${encodeURIComponent(minifiedQuery)}`;
                            
                            if (fetchVariables) {
                                getUrl += `&variables=${encodeURIComponent(JSON.stringify(fetchVariables))}`;
                            }

                            response = await fetch(getUrl, {
                                method: "GET",
                                headers: { 
                                    "accept": "application/json",
                                    "apollo-require-preflight": "true"
                                },
                                signal: AbortSignal.timeout(15000)
                            });
                        }

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
export const introspectHandler = async (args: { 
    typeNames?: string[], 
    typeDepth?: number, 
    endpoint?: string,
    headers?: string 
}) => {
    let runtimeHeaders: Record<string, string> = {};
    if (args.headers) {
        try {
            runtimeHeaders = JSON.parse(args.headers);
        } catch {
            console.error("[WARN] Failed to parse custom headers JSON in introspect-schema");
        }
    }

    const hasEndpointOverride = !!(args.endpoint && args.endpoint.trim().length > 0);
    const activeEndpoint = hasEndpointOverride
        ? args.endpoint!.trim()
        : env.ENDPOINT;
    
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
    // Cache key (endpoint + headers) decides hits/misses; reserve force-refresh
    // for an explicit refresh operation rather than every endpoint/header override.
    const schemaEntry = await getSchema(
        false,
        cleanTypeNames,
        depth,
        runtimeHeaders,
        activeEndpoint,
    );

    if (schemaEntry.cachedSchemas.length === 0) {
        return { content: [{ type: "text" as const, text: "❌ System is not initialized." }] };
    }

    if (!typeNames || typeNames.length === 0) {
        const manifest = schemaEntry.nodeManifest || [];
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
        for (const schema of schemaEntry.cachedSchemas) {
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
        headers: z.string().optional().describe("JSON stringified object of extra HTTP headers for the introspection request (e.g. '{\"Authorization\": \"Bearer token\"}').")
    }, 
    introspectHandler
);

// --- PROMPT REGISTRY ---
registerPrompt(server, "system-health", "Check status of all nodes", "Perform a simple __typename query on all endpoints.");

async function executeGraphQL(
    query: string,
    variables: any,
    requestMeta?: { host?: string | null; waitUntil?: (promise: Promise<void> | void) => void },
) {
    const handler = toolHandlers.get("query-graphql");
    if (!handler) {
        throw new Error("GraphQL handler not found");
    }

    const mcpResult = await handler({ query, variables, _request_meta: requestMeta });
    
    if (mcpResult.isError) {
        return { errors: [{ message: mcpResult.content[0].text }] };
    }

    const resultText = mcpResult.content[0].text;
    const parsed = JSON.parse(resultText);
    return parsed.data ? parsed : { data: parsed };
}

/**
 * Shared WHATWG Fetch HTTP adapter, usable on Node, Cloudflare Workers, Bun, etc.
 */
const defaultCorsOrigins = [
    `http://localhost:${env.MCP_PORT}`,
    `http://127.0.0.1:${env.MCP_PORT}`,
    `http://[::1]:${env.MCP_PORT}`,
];

export const httpAdapter = createMcpHttpAdapter({
    name: env.NAME,
    headers: env.HEADERS,
    version,
    corsOrigins: [...defaultCorsOrigins, ...env.CORS_ORIGINS],
    toolHandlers,
    registeredToolsMetadata,
    executeGraphQL,
});
