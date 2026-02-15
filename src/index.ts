#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse } from "graphql/language";
import z from "zod";
import { renderGraphiQL} from "./helpers/graphiql.js";

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
});

// --- CACHE STATE ---
let cachedSDL: string | null = null;
let cachedSchemaObject: any = null;
let schemaLoadError: Error | null = null;

async function getSchema(): Promise<string> {
    if (cachedSDL) return cachedSDL;
    if (schemaLoadError) throw schemaLoadError;

    try {
        const { buildClientSchema, getIntrospectionQuery, printSchema, buildASTSchema, parse: gqlParse } = require("graphql");
        let sdl: string;

        if (env.SCHEMA) {
            // Check if it's a URL or local path
            if (env.SCHEMA.startsWith("http")) {
                const response = await fetch(env.SCHEMA);
                sdl = await response.text();
            } else {
                sdl = await introspectLocalSchema(env.SCHEMA);
            }
            cachedSchemaObject = buildASTSchema(gqlParse(sdl));
            cachedSDL = sdl;
        } else {
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

// --- TOOL HANDLERS ---
const toolHandlers = new Map();

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

        const data = await response.json();
        return { 
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] 
        };
    } catch (error: any) {
        throw new Error(`Execution failed: ${error.message}`);
    }
};

toolHandlers.set("query-graphql", queryGraphqlHandler);
server.tool(
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
    await getSchema();
    if (!typeNames || typeNames.length === 0) {
        const allTypeNames = Object.keys(cachedSchemaObject.getTypeMap()).filter(t => !t.startsWith('__'));
        return { 
            content: [{ type: "text" as const, text: `Schema is large. Available types: ${allTypeNames.join(", ")}` }] 
        };
    }
    const filtered = introspectSpecificTypes(cachedSchemaObject, typeNames);
    return { 
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }] 
    };
};

toolHandlers.set("introspect-schema", introspectHandler);
server.tool(
    "introspect-schema", 
    "Introspect the GraphQL schema with optional type filtering",
    {
        typeNames: z.array(z.string()).optional(),
    }, 
    introspectHandler
);


// --- HTTP SERVER LOGIC ---
async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || '', `http://${req.headers.host}`);

    // NEW FEATURE: Web GUI for Humans
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/graphiql')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // Pass env.HEADERS to the explorer
        return res.end(renderGraphiQL(env.ENDPOINT, env.HEADERS));
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { method, params, id } = JSON.parse(body);
                console.error(`[HTTP-RPC] Method: ${method} | ID: ${id}`);

                const handler = toolHandlers.get(method);
                if (!handler) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: "Method not found" } }));
                }

                const result = await handler(params);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
            } catch (e: any) {
                console.error(`[HTTP-ERROR] ${e.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: "Internal Error" } }));
            }
        });
        return;
    }
    
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: "ok", server: env.NAME }));
    }

    res.writeHead(404);
    res.end("Not Found");
}

// --- STARTUP ---
async function main() {
    if (env.ENABLE_HTTP) {
        const serverHttp = http.createServer(handleHttpRequest);
        serverHttp.listen(env.MCP_PORT, () => {
            console.error(`[HTTP] Server started on http://localhost:${env.MCP_PORT}`);
            console.error(`🎨 GraphiQL IDE: http://localhost:${env.MCP_PORT}/graphiql`);
            console.error(`🤖 MCP Endpoint: http://localhost:${env.MCP_PORT}/mcp\n`);
        });
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[STDIO] MCP Server "${env.NAME}" v${getVersion()} started`);

    getSchema().catch(e => console.error(`[SCHEMA] Warning: Preload failed: ${e.message}`));
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(error => {
    console.error(`[FATAL] ${error}`);
    process.exit(1);
});