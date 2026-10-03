#!/usr/bin/env node

import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isDocker } from "./helpers/container.js";
import { checkDeprecatedArguments } from "./helpers/deprecation.js";
import {
	env,
	getSchema,
	httpAdapter,
	server,
} from "./index.js";

// CLI-only: keep argv checks out of the library export surface.
checkDeprecatedArguments();

// --- SERVER LIFECYCLE (Node CLI) ---
async function main() {
	const isInspector = !!(
		process.env.MCP_INSPECTOR ||
		process.env.INSPECTOR_PORT ||
		process.env.INSPECTOR_URL
	);
	const shouldStartHttp = env.ENABLE_HTTP && !isInspector;

	// Attach STDIO when stdin is a piped stream (!isTTY)
	const isPipe =
		typeof process !== "undefined" && process.stdin && !process.stdin.isTTY;
	if (isPipe) {
		const stdioTransport = new StdioServerTransport();

		if (shouldStartHttp) {
			// In HTTP mode, initialize STDIO in the background without blocking execution
			// or registering process.exit(0) on stdin close (prevents instant exits in cloud containers like Render).
			server.connect(stdioTransport).catch((err) => {
				console.error("[WARN] STDIO transport failed in dual mode:", err);
			});
		} else {
			// In pure STDIO mode, connect synchronously and attach normal lifecycle handlers
			await server.connect(stdioTransport);
			process.stdin.on("close", () => process.exit(0));
		}
	}

	if (shouldStartHttp) {
		const httpSrv = createServer(httpAdapter);

		const start = (port: number) => {
			httpSrv.removeAllListeners("error");
			httpSrv.removeAllListeners("listening");

			httpSrv.once("error", (e: any) => {
				if (e.code === "EADDRINUSE") {
					if (isDocker()) {
						// Port incrementing is ineffective inside Docker due to fixed host mapping (-p)
						console.error(
							`[FATAL] Port ${port} is already in use. Port fallback is disabled in Docker. Exiting...`,
						);
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

			httpSrv.listen(port, "0.0.0.0", () => {
				const address = httpSrv.address();
				const actualPort =
					typeof address === "object" && address ? address.port : port;
				console.error(
					`[SYSTEM] Federated Bridge active on port ${actualPort}`,
				);
				console.error(
					`📡 MCP Endpoint: http://localhost:${actualPort}/mcp`,
				);
				if (process.env.ENABLE_HTTP === "true") {
					console.error(
						`🎨 GraphiQL: http://localhost:${actualPort}/graphiql`,
					);
				}
			});
		};

		start(env.MCP_PORT);
	}

	console.error(`[BOOT] Initializing schema sync for: ${env.ENDPOINT}`);
	getSchema(true).catch((err) =>
		console.error(`[BOOT-WARN] Initial sync failed: ${err.message}`),
	);
}

process.on("SIGINT", () => {
	console.error("[SYSTEM] Shutting down...");
	process.exit(0);
});
process.on("SIGTERM", () => {
	process.exit(0);
});

main().catch((err: any) => {
	console.error(`[FATAL] Startup failed: ${err.message}`);
	process.exit(1);
});
