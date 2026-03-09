# mcp-graphql-enhanced
[![Glama](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced/badge)](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced)
An **enhanced MCP (Model Context Protocol) server for GraphQL** that fixes real-world interoperability issues between LLMs and GraphQL APIs.
> Drop-in replacement for `mcp-graphql` — with dynamic headers, robust variables parsing, and zero breaking changes.

## 💬 Community & Support

Join the conversation! If you have questions about using this bridge with Neo4j, Discord data graphs, or GraphQL in general, come hang out with us:

* **Discord Channel:** [#mcp-graphql-enhanced](https://discord.com/channels/625400653321076807/1480510460339159184)
* **Server:** The official **GraphQL Discord**

This is the best place to share your feedback, report issues, or suggest new "enhanced" features for the bridge.

## ✨ Key Enhancements
* ✅ **Built-in GraphiQL IDE** — Visual playground at http://localhost:MCP_PORT/ (or /graphiql) with pre-configured headers.
* ✅ **Dual Transport** — Supports both **STDIO** (for local CLI/client tools) and **HTTP/JSON-RPC** (for external/browser clients).
* ✅ **Dynamic headers** — pass `Authorization`, `X-API-Key`, etc., via tool arguments (no config restarts)
* ✅ **Robust variables parsing** — fixes `“Query variables must be a null or an object”` error
* ✅ **Filtered introspection** — request only specific types (e.g., `typeNames: ["Query", "User"]`) to reduce LLM context noise
* ✅ **Full MCP compatibility** — works with **Claude Desktop**, **Cursor**, **Glama**
* ✅ **Secure by default** — mutations disabled unless explicitly enabled
* ✅ **Dynamic Schema Evolution** — Smart diagnostics and gap analysis for servers that regenerate GraphQL types on-the-fly (like Neo4j).
* ✅ **Deep Observability** — Automatic Cypher extraction and cleaning from GraphQL extensions.

## 🔍 Advanced Observability & Cypher
The bridge provides deep insights into how the LLM interacts with your graph database. 

### 🕸️ Automated Cypher Extraction
For GraphQL server implementations that return query execution plans (like `@neo4j/graphql`), the bridge automatically:
1. **Detects** `extensions.cypher` in the response.
2. **Sanitizes** the output by stripping internal headers (like `CYPHER 5` or empty `PARAMS`).
3. **Injects** a clean Cypher block directly into the tool's output for the AI to analyze.

> **Note:** This feature requires your GraphQL server to be configured to include debug information in the response extensions.

---
## 🎨 Visual Command Center (GraphiQL)
Unlike standard MCP servers, this one provides a visual interface for humans. When running with `ENABLE_HTTP=true`, you can open a full-featured **GraphiQL IDE** in your browser.

* **Endpoint:** `http://localhost:6274/` (or `/graphiql`)
* **Header Sync:** Any headers set in your environment (like GitHub tokens) are automatically injected into the GraphiQL "Headers" tab for immediate testing.

## 💻 HTTP / Dual Transport

This server now runs in **dual transport mode**, supporting both the standard **STDIO** communication (used by most MCP clients) and a new **HTTP JSON-RPC** endpoint on port `6274`.

This allows external systems, web applications, and direct `curl` commands to access the server's tools with **live request logging** in your terminal (`[HTTP-RPC]` logs).

| **Endpoint** | **Method** | **Description** |
| :--- | :--- | :--- |
| `/graphiql` | `GET` | Human Interface: The visual GraphQL IDE. |
| `/mcp` | `POST` | The main JSON-RPC 2.0 endpoint for tool execution. |
| `/health` | `GET` | Simple health check, returns `{ status: 'ok' }`. |

### Automatic Port Selection
The server defaults to port `6274`. If you encounter an `EADDRINUSE` error, the server will automatically find the next available port. **Check the server logs for the final bound port** (e.g., `[HTTP] Started server on http://localhost:6275`).

### Resolving Port Conflicts (EADDRINUSE) and Automatic Port Selection

The server defaults to port `6274`. If you encounter an `EADDRINUSE: address already in use :::6274` error (common in local development due to stale processes), the server will automatically find the next available port (up to 10 attempts, not spawning multiple servers).

This ensures the server starts successfully even when the default is blocked. **Always check the server logs for the final bound port** (e.g., `[HTTP] Started server on http://localhost:6275`) if your `curl` or client tool fails on the default `6274`.

To **force a specific port** (e.g., for guaranteed external firewall settings), you can still explicitly set the `MCP_PORT` environment variable:

### Testing the HTTP Endpoint

You can test the endpoint using `curl` as long as the server is running (e.g., via `npm run dev`):

```bash
# Test the health check (assuming the server bound to the default or found the next available port)
curl http://localhost:6274/health

# Example: Test the query tool via JSON-RPC (using port 6275 if 6274 was busy)
curl -X POST http://localhost:6275/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"query-graphql","params":{"query":"query { __typename }"},"id":1}'

## 🔍 Filtered Introspection
Avoid 50k-line schema dumps. Ask for only what you need:
`@introspect-schema typeNames ["Query", "User"]`
## 🔍 Debug & Inspect
Use the official MCP Inspector to test your server live:
```bash
npx @modelcontextprotocol/inspector \
  -e ENDPOINT=https://api.example.com/graphql \
  npx @letoribo/mcp-graphql-enhanced
```
### Environment Variables (Breaking change in 1.0.0)
> **Note:** As of version 1.0.0, command line arguments have been replaced with environment variables.

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `ENDPOINT` | GraphQL endpoint URL | `https://mcp-neo4j-discord.vercel.app/api/graphiql` |
| `HEADERS` | JSON string containing headers for requests | `{}` |
| `ALLOW_MUTATIONS` | Enable mutation operations (disabled by default) | `false` |
| `NAME` | Name of the MCP server | `mcp-graphql-enhanced` |
| `SCHEMA` | Path to a local GraphQL schema file or URL | - |
| `MCP_PORT` | Port for the HTTP/JSON-RPC server. | `6274` |
| `ENABLE_HTTP` | Enable HTTP transport: `auto` (default), `true`, or `false` | `auto` |
| `DEBUG` | Set to `mcp:*` for detailed SDK logs | - |
**Note on `ENABLE_HTTP`:** 
- `auto` (default): Automatically enables HTTP only when running in MCP Inspector...
- `true`: Always enable HTTP server
- `false`: Disable HTTP server completely
### Examples
```bash
# Basic usage
ENDPOINT=http://localhost:3000/graphql npx @letoribo/mcp-graphql-enhanced
# With auth header
ENDPOINT=https://api.example.com/graphql \
HEADERS='{"Authorization":"Bearer xyz"}' \
npx @letoribo/mcp-graphql-enhanced
# Enable mutations
ENDPOINT=http://localhost:3000/graphql \
ALLOW_MUTATIONS=true \
npx @letoribo/mcp-graphql-enhanced
# Use local schema file
ENDPOINT=http://localhost:3000/graphql \
SCHEMA=./schema.graphql \
npx @letoribo/mcp-graphql-enhanced
# Change the HTTP port
MCP_PORT=8080 npx @letoribo/mcp-graphql-enhanced
# Disable HTTP transport (fastest, recommended for Claude Desktop)
ENABLE_HTTP=false npx @letoribo/mcp-graphql-enhanced
# Test the surgical precision and the IDE immediately:
ENDPOINT=https://api.github.com/graphql \
HEADERS='{"Authorization":"Bearer YOUR_GITHUB_TOKEN"}' \
ENABLE_HTTP=true \
npx @letoribo/mcp-graphql-enhanced

# Then visit http://localhost:6274/graphiql
```
### 🖥️ Claude Desktop Configuration Examples
You can connect Claude Desktop to your GraphQL API using either the npx package (recommended for simplicity) or the Docker image (ideal for reproducibility and isolation).
### ✅ Option 1: Using npx
```bash
{
  "mcpServers": {
    "mcp-graphql-enhanced": {
      "command": "npx",
      "args": ["@letoribo/mcp-graphql-enhanced"],
      "env": {
        "ENDPOINT": "https://your-api.com/graphql"
      }
    }
  }
}
```
### 🐳 Option 2: Using Docker (auto-pull supported)
```bash
{
  "mcpServers": {
    "mcp-graphql-enhanced": {
      "command": "sh",
      "args": [
        "-c",
        "docker run --rm -i -e ENDPOINT=$ENDPOINT -e HEADERS=$HEADERS -e ALLOW_MUTATIONS=$ALLOW_MUTATIONS ghcr.io/letoribo/mcp-graphql-enhanced:main"
      ],
      "env": {
        "ENDPOINT": "https://your-api.com/graphql",
        "HEADERS": "{\"Authorization\": \"Bearer YOUR_TOKEN\"}",
        "ALLOW_MUTATIONS": "false"
      }
    }
  }
}
```
### 🧪 Option 3: Using node with local build (for development)
If you’ve cloned the repo and built the project (npm run build → outputs to dist/):
```bash
{
  "mcpServers": {
    "mcp-graphql-enhanced": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "ENDPOINT": "https://your-api.com/graphql",
        "ALLOW_MUTATIONS": "true"
      }
    }
  }
}
```
## Resources
- **graphql-schema**: The server exposes the GraphQL schema as a resource that clients can access. This is either the local schema file, a schema file hosted at a URL, or based on an introspection query.
## Available Tools
The server provides two main tools:
1. **introspect-schema**: This tool retrieves the GraphQL schema or a filtered subset (via typeNames). Use this first if you don't have access to the schema as a resource.
This uses either the local schema file, a schema file hosted at a URL, or an introspection query.
Filtered introspection (typeNames) is only available when using a live GraphQL endpoint (not with SCHEMA file or URL).
2. **query-graphql**: Execute GraphQL queries against the endpoint. By default, mutations are disabled unless `ALLOW_MUTATIONS` is set to `true`.
## Security Considerations
Mutations are disabled by default to prevent unintended data changes. Always validate HEADERS and SCHEMA inputs in production. Use HTTPS endpoints and short-lived tokens where possible.
## Customize for your own server
This is a very generic implementation where it allows for complete introspection and for your users to do whatever (including mutations). If you need a more specific implementation I'd suggest to just create your own MCP and lock down tool calling for clients to only input specific query fields and/or variables. You can use this as a reference.
