import {
	createServerAdapter,
	useCORS,
	Response,
	type WaitUntilFn,
} from "@whatwg-node/server";
import { renderGraphiQL } from "./graphiql.js";

export type McpRequestMeta = {
	host?: string | null;
	/** whatwg-node / Workers waitUntil — keeps background work alive until settled. */
	waitUntil?: WaitUntilFn;
};

export type McpHttpAdapterDeps = {
	name: string;
	headers: Record<string, unknown> | object;
	version: string;
	/** Allowed browser Origins for CORS (exact match; reflected when present). */
	corsOrigins?: string[];
	toolHandlers: Map<string, (args: any) => Promise<any>>;
	registeredToolsMetadata: any[];
	executeGraphQL: (
		query: string,
		variables: any,
		requestMeta?: McpRequestMeta,
	) => Promise<any>;
};

/**
 * Platform-agnostic HTTP surface for MCP JSON-RPC, GraphiQL, and GraphQL facade.
 * Built with `@whatwg-node/server`: write once against Fetch (`Request` / `Response`),
 * then mount the adapter on Node, Cloudflare Workers, Bun, and other runtimes.
 */
export function createMcpHttpAdapter(deps: McpHttpAdapterDeps) {
	const jsonResponse = (
		data: any,
		statusCode: number = 200,
		requestMeta?: Record<string, any>,
	) => {
		const responseBody: any = { ...data };
		if (requestMeta && Object.keys(requestMeta).length > 0) {
			responseBody._meta = requestMeta;
		}
		return Response.json(responseBody, { status: statusCode });
	};

	const isAllowedOrigin = (request: Request): boolean => {
		const origin = request.headers.get("origin");
		// Non-browser clients typically omit Origin.
		if (!origin) {
			return true;
		}
		return (deps.corsOrigins ?? []).includes(origin);
	};

	return createServerAdapter(
		async (request: Request, serverContext) => {
			// MCP Streamable HTTP: invalid Origins must be rejected before dispatch
			// (CORS alone only hides the response; simple POSTs would still run).
			if (!isAllowedOrigin(request)) {
				return new Response("Forbidden: Origin not allowed", {
					status: 403,
				});
			}

			const requestMetaBase: McpRequestMeta = {
				host: request.headers.get("host"),
				waitUntil: serverContext.waitUntil.bind(serverContext),
			};

			const url = new URL(request.url);

			if (request.method === "GET") {
				switch (url.pathname) {
					case "/":
					case "/graphql":
					case "/graphiql": {
						// Same-origin path follows whatever host/port the adapter is
						// actually mounted on (CLI fallback, reverse proxy, Worker, etc.).
						return new Response(
							renderGraphiQL("/mcp", deps.headers as object),
							{
								status: 200,
								headers: { "Content-Type": "text/html" },
							},
						);
					}
					case "/health":
						return Response.json({
							status: "ok",
							version: deps.version,
						});
					default:
						return Response.json({ error: "Not Found" }, { status: 404 });
				}
			}

			if (request.method === "POST") {
				const body = await request.text();

				switch (url.pathname) {
					case "/mcp": {
						let payload: any;
						try {
							payload = JSON.parse(body);
						} catch (e: any) {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id: null,
									error: {
										code: -32700,
										message: `Parse error: ${e.message}`,
									},
								},
								400,
							);
						}

						if (
							payload === null ||
							typeof payload !== "object" ||
							Array.isArray(payload)
						) {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id: null,
									error: {
										code: -32600,
										message: "Invalid Request: JSON-RPC body must be an object",
									},
								},
								400,
							);
						}

						const { method, id, params } = payload;
						const isGraphQLFacade =
							method === undefined && typeof payload.query === "string";

						// JSON-RPC requests must declare jsonrpc "2.0" and a string method.
						// The methodless GraphQL facade ({ query, variables }) stays exempt.
						if (!isGraphQLFacade) {
							if (payload.jsonrpc !== "2.0") {
								return jsonResponse(
									{
										jsonrpc: "2.0",
										id: id ?? null,
										error: {
											code: -32600,
											message:
												'Invalid Request: jsonrpc must be "2.0"',
										},
									},
									400,
								);
							}

							if (typeof method !== "string") {
								return jsonResponse(
									{
										jsonrpc: "2.0",
										id: id ?? null,
										error: {
											code: -32600,
											message:
												"Invalid Request: method must be a string",
										},
									},
									400,
								);
							}
						}

						// Keep JSON-RPC _meta scoped to this request only.
						const requestMeta: Record<string, any> =
							params?._meta && typeof params._meta === "object"
								? { ...params._meta }
								: {};

						if (method === "initialize") {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id,
									result: {
										protocolVersion: "2025-11-25",
										capabilities: { tools: {}, prompts: {} },
										serverInfo: {
											name: deps.name,
											version: deps.version,
										},
									},
								},
								200,
								requestMeta,
							);
						}

						if (method?.startsWith("notifications/")) {
							// MCP Streamable HTTP: accepted notifications -> 202, empty body.
							return new Response(null, { status: 202 });
						}

						if (method === "ping") {
							return jsonResponse(
								{ jsonrpc: "2.0", id, result: {} },
								200,
								requestMeta,
							);
						}

						if (!payload.method && payload.query) {
							const handler = deps.toolHandlers.get("query-graphql");
							if (handler) {
								try {
									const mcpResult = await handler({
										query: payload.query,
										variables: payload.variables,
										_request_meta: requestMetaBase,
									});

									const resultText = mcpResult.content[0].text;
									if (mcpResult.isError || resultText.startsWith("❌")) {
										return jsonResponse(
											{ errors: [{ message: resultText }] },
											400,
											requestMeta,
										);
									}

									try {
										const parsed = JSON.parse(resultText);
										const graphQLResponse = parsed.data
											? parsed
											: { data: parsed };
										return jsonResponse(
											graphQLResponse,
											200,
											requestMeta,
										);
									} catch {
										return jsonResponse(
											{ data: { result: resultText } },
											200,
											requestMeta,
										);
									}
								} catch (err: any) {
									return jsonResponse(
										{
											errors: [
												{ message: err.message || "Execution error" },
											],
										},
										500,
										requestMeta,
									);
								}
							}
						}

						if (method === "tools/list" || method === "list-tools") {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id,
									result: { tools: deps.registeredToolsMetadata },
								},
								200,
								requestMeta,
							);
						}

						if (method === "prompts/list" || method === "list-prompts") {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id,
									result: { prompts: [] },
								},
								200,
								requestMeta,
							);
						}

						const target =
							method === "call-tool" || method === "tools/call"
								? params?.name
								: method;
						const args =
							method === "call-tool" || method === "tools/call"
								? params?.arguments
								: params;

						const handler = deps.toolHandlers.get(target);
						if (!handler) {
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id,
									error: {
										code: -32601,
										message: `Method ${target} not found`,
									},
								},
								200,
								requestMeta,
							);
						}

						const enrichedArgs = {
							...args,
							_request_meta: requestMetaBase,
						};

						try {
							const result = await handler(enrichedArgs);
							return jsonResponse(
								{ jsonrpc: "2.0", id, result },
								200,
								requestMeta,
							);
						} catch (err) {
							const errorMessage =
								err instanceof Error ? err.message : String(err);
							return jsonResponse(
								{
									jsonrpc: "2.0",
									id,
									error: {
										code: -32603,
										message: errorMessage || "Internal handler error",
									},
								},
								200,
								requestMeta,
							);
						}
					}

					case "/":
					case "/graphql":
					case "/graphiql":
						try {
							const { query, variables } = JSON.parse(body);
							const result = await deps.executeGraphQL(
								query,
								variables,
								requestMetaBase,
							);
							return Response.json(result);
						} catch (e: any) {
							return Response.json({
								errors: [
									{
										message: e?.message || "Invalid GraphQL request",
									},
								],
							});
						}

					default:
						return Response.json(
							{ error: "Endpoint not found" },
							{ status: 404 },
						);
				}
			}

			return Response.json(
				{ error: "Method Not Allowed" },
				{ status: 405 },
			);
		},
		{
			plugins: [
				useCORS(
					deps.corsOrigins?.length
						? {
								// Exact-match allowlist; plugin reflects the request Origin when listed.
								origin: deps.corsOrigins,
								credentials: false,
								methods: ["GET", "POST", "OPTIONS"],
								allowedHeaders: ["Content-Type"],
							}
						: false,
				),
			],
		},
	);
}
