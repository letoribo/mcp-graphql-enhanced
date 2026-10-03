import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpHttpAdapter } from "./http-adapter.js";

function createTestAdapter() {
	const toolHandlers = new Map<string, (args: any) => Promise<any>>();
	toolHandlers.set("query-graphql", async () => ({
		content: [{ type: "text", text: JSON.stringify({ data: { ok: true } }) }],
	}));

	return createMcpHttpAdapter({
		name: "test-mcp",
		headers: {},
		version: "test",
		corsOrigins: [
			"http://localhost:6274",
			"http://127.0.0.1:6274",
		],
		toolHandlers,
		registeredToolsMetadata: [{ name: "query-graphql" }],
		executeGraphQL: async () => ({ data: { ok: true } }),
	});
}

describe("createMcpHttpAdapter (adapter.fetch, no real HTTP server)", () => {
	it("serves /health", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/health");
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			status: "ok",
			version: "test",
		});
	});

	it("points GraphiQL at same-origin /mcp", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://127.0.0.1:9999/graphiql");
		assert.equal(response.status, 200);
		const html = await response.text();
		assert.match(html, /["']\/mcp["']/);
		assert.doesNotMatch(html, /localhost:6274|localhost:9999/);
	});

	it("keeps notification responses bodyless", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
		});
		assert.equal(response.status, 202);
		assert.equal(await response.text(), "");
	});

	it("does not reflect untrusted CORS origins", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/health", {
			headers: { Origin: "https://evil.example" },
		});
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	});

	it("rejects untrusted Origin on /mcp before dispatch", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Origin: "https://evil.example",
				"Content-Type": "text/plain",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ping",
			}),
		});
		assert.equal(response.status, 403);
	});

	it("reflects same-origin CORS requests", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost:6274/health", {
			headers: { Origin: "http://localhost:6274" },
		});
		assert.equal(response.status, 200);
		assert.equal(
			response.headers.get("access-control-allow-origin"),
			"http://localhost:6274",
		);
	});

	it("scopes JSON-RPC _meta to the current request only", async () => {
		await using adapter = createTestAdapter();

		const withMeta = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ping",
				params: { _meta: { client: "a" } },
			}),
		});
		assert.deepEqual(await withMeta.json(), {
			jsonrpc: "2.0",
			id: 1,
			result: {},
			_meta: { client: "a" },
		});

		const withoutMeta = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "ping",
				params: {},
			}),
		});
		assert.deepEqual(await withoutMeta.json(), {
			jsonrpc: "2.0",
			id: 2,
			result: {},
		});
	});

	it("rejects non-object JSON-RPC bodies with -32600", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "null",
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Invalid Request: JSON-RPC body must be an object",
			},
		});
	});

	it("includes id null on JSON parse errors", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});
		assert.equal(response.status, 400);
		const payload = await response.json();
		assert.equal(payload.jsonrpc, "2.0");
		assert.equal(payload.id, null);
		assert.equal(payload.error.code, -32700);
	});

	it("rejects non-string JSON-RPC methods with -32600", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: 42,
				params: {},
			}),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -32600,
				message: "Invalid Request: method must be a string",
			},
		});
	});

	it("rejects non-2.0 jsonrpc with -32600", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "1.0",
				id: 1,
				method: "ping",
			}),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -32600,
				message: 'Invalid Request: jsonrpc must be "2.0"',
			},
		});
	});

	it("rejects JSON-RPC bodies missing method with -32600", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
			}),
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -32600,
				message: "Invalid Request: method must be a string",
			},
		});
	});

	it("still accepts the methodless GraphQL facade", async () => {
		await using adapter = createTestAdapter();
		const response = await adapter.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "{ __typename }",
			}),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { data: { ok: true } });
	});

	it("drains waitUntil work on adapter dispose", async () => {
		let settled = false;
		const toolHandlers = new Map<string, (args: any) => Promise<any>>();
		toolHandlers.set("query-graphql", async (args) => {
			assert.equal(typeof args._request_meta?.waitUntil, "function");
			assert.equal(args._request_meta?.host, "localhost");
			// Slow background job: only finishes after response returns.
			args._request_meta.waitUntil(
				new Promise<void>((resolve) => {
					setTimeout(() => {
						settled = true;
						resolve();
					}, 30);
				}),
			);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ data: { ok: true } }) },
				],
			};
		});

		{
			await using adapter = createMcpHttpAdapter({
				name: "test-mcp",
				headers: {},
				version: "test",
				corsOrigins: ["http://localhost:6274"],
				toolHandlers,
				registeredToolsMetadata: [{ name: "query-graphql" }],
				executeGraphQL: async () => ({ data: { ok: true } }),
			});

			const response = await adapter.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Host: "localhost",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "query-graphql",
						arguments: { query: "{ __typename }" },
					},
				}),
			});
			assert.equal(response.status, 200);
			// Response returned before the waitUntil job finished.
			assert.equal(settled, false);
		}
		// await using dispose() awaits pending waitUntil promises.
		assert.equal(settled, true);
	});
});
