#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { parse } = require("graphql/language");
const z = require("zod").default;
const { checkDeprecatedArguments } = require("./helpers/deprecation.js");
const {
	introspectEndpoint,
	introspectLocalSchema,
	introspectSchemaFromUrl,
} = require("./helpers/introspection.js");

// Simulate macro import — since "with { type: 'macro' }" is not CommonJS compatible
const getVersion = () => {
	// Replace with your actual version or read from package.json
	const pkg = require("../package.json");
	return pkg.version;
};

// Check for deprecated command line arguments
checkDeprecatedArguments();

const EnvSchema = z.object({
	NAME: z.string().default("mcp-graphql"),
	ENDPOINT: z.string().url().default("http://localhost:4000/graphql"),
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
});

const env = EnvSchema.parse(process.env);

const server = new McpServer({
	name: env.NAME,
	version: getVersion(),
	description: `GraphQL MCP server for ${env.ENDPOINT}`,
});

server.resource("graphql-schema", new URL(env.ENDPOINT).href, async (uri: URL) => { 
	try {
		let schema;
		if (env.SCHEMA) {
			if (
				env.SCHEMA.startsWith("http://") ||
				env.SCHEMA.startsWith("https://")
			) {
				schema = await introspectSchemaFromUrl(env.SCHEMA);
			} else {
				schema = await introspectLocalSchema(env.SCHEMA);
			}
		} else {
			schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
		}

		return {
			contents: [
				{
					uri: uri.href,
					text: schema,
				},
			],
		};
	} catch (error) {
		throw new Error(`Failed to get GraphQL schema: ${error}`);
	}
});

server.tool(
	"introspect-schema",
	"Introspect the GraphQL schema, use this tool before doing a query to get the schema information if you do not have it available as a resource already.",
	{
		__ignore__: z
			.boolean()
			.default(false)
			.describe("This does not do anything"),
	},
	async () => {
		try {
			let schema;
			if (env.SCHEMA) {
				schema = await introspectLocalSchema(env.SCHEMA);
			} else {
				schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
			}

			return {
				content: [
					{
						type: "text",
						text: schema,
					},
				],
			};
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Failed to introspect schema: ${error}`,
					},
				],
			};
		}
	},
);

server.tool(
	"query-graphql",
	"Query a GraphQL endpoint with the given query and variables. Optionally pass headers (e.g., for Authorization).",
	{
		query: z.string(),
		variables: z.string().optional(),
		headers: z
			.string()
			.optional()
			.describe("Optional JSON string of headers to include, e.g., {\"Authorization\": \"Bearer ...\"}"),
	},
	async ({ query, variables, headers }: { query: string; variables?: string; headers?: string }) => {
		try {
			const parsedQuery = parse(query);

			const isMutation = parsedQuery.definitions.some(
				(def: any) =>
					def.kind === "OperationDefinition" && def.operation === "mutation",
			);

			if (isMutation && !env.ALLOW_MUTATIONS) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Mutations are not allowed unless you enable them in the configuration. Please use a query operation instead.",
						},
					],
				};
			}
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Invalid GraphQL query: ${error}`,
					},
				],
			};
		}

		try {
			const toolHeaders = headers
				? JSON.parse(headers)
				: {};

			const allHeaders = {
				"Content-Type": "application/json",
				...env.HEADERS,
				...toolHeaders,
			};

			// Parse variables if it's a string
			let parsedVariables = null;
			if (variables) {
				if (typeof variables === 'string') {
					parsedVariables = JSON.parse(variables);
				} else {
					parsedVariables = variables;
				}
			}

			const response = await fetch(env.ENDPOINT, {
				method: "POST",
				headers: allHeaders,
				body: JSON.stringify({
					query,
					variables: parsedVariables,
				}),
			});

			if (!response.ok) {
				const responseText = await response.text();
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `GraphQL request failed: ${response.statusText}\n${responseText}`,
						},
					],
				};
			}

			const rawData = await response.json();

			// Type assertion for quick dev (replace with zod validation later)
			const data = rawData as any;

			if (data.errors && data.errors.length > 0) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `GraphQL errors: ${JSON.stringify(data.errors, null, 2)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(data, null, 2),
					},
				],
			};
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Failed to execute GraphQL query: ${error}`,
					},
				],
			};
		}
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error(
		`Started graphql mcp server ${env.NAME} for endpoint: ${env.ENDPOINT}`,
	);
}

main().catch((error) => {
	console.error(`Fatal error in main(): ${error}`);
	process.exit(1);
});