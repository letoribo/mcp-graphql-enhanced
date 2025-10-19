# mcp-graphql-enhanced
[![Smithery](https://smithery.ai/badge/@letoribo/mcp-graphql-enhanced)](https://smithery.ai/server/@letoribo/mcp-graphql-enhanced)
[![Glama](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced/badge)](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced)
An **enhanced MCP (Model Context Protocol) server for GraphQL** that fixes real-world interoperability issues between LLMs and GraphQL APIs.
> Drop-in replacement for `mcp-graphql` — with dynamic headers, robust variables parsing, and zero breaking changes.
## ✨ Key Enhancements
- ✅ **Dynamic headers** — pass `Authorization`, `X-API-Key`, etc., via tool arguments (no config restarts)
- ✅ **Robust variables parsing** — fixes `“Query variables must be a null or an object”` error
- ✅ **Filtered introspection** — request only specific types (e.g., `typeNames: ["Query", "User"]`) to reduce LLM context noise
- ✅ **Full MCP compatibility** — works with **Claude Desktop**, **Cursor**, **Glama**, and **Smithery**
- ✅ **Secure by default** — mutations disabled unless explicitly enabled
## 🔍 Filtered Introspection (New!)
Avoid 50k-line schema dumps. Ask for only what you need:
```@introspect-schema typeNames ["Query", "User"]```
## 🔍 Debug & Inspect
Use the official MCP Inspector to test your server live:
```bash
npx @modelcontextprotocol/inspector \
  -e ENDPOINT=https://api.example.com/graphql \
  npx @letoribo/mcp-graphql-enhanced --debug
```
### Environment Variables (Breaking change in 1.0.0)
> **Note:** As of version 1.0.0, command line arguments have been replaced with environment variables.

| Environment Variable | Description | Default |
|----------|-------------|---------|
| `ENDPOINT` | GraphQL endpoint URL | `http://localhost:4000/graphql` |
| `HEADERS` | JSON string containing headers for requests | `{}` |
| `ALLOW_MUTATIONS` | Enable mutation operations (disabled by default) | `false` |
| `NAME` | Name of the MCP server | `mcp-graphql-enhanced` |
| `SCHEMA` | Path to a local GraphQL schema file or URL (optional) | - |
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
## Installation
#### Installing via Smithery
To install GraphQL MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@letoribo/mcp-graphql-enhanced):
```bash
npx -y @smithery/cli install @letoribo/mcp-graphql-enhanced --client claude
```
## Security Considerations
Mutations are disabled by default to prevent unintended data changes. Always validate HEADERS and SCHEMA inputs in production. Use HTTPS endpoints and short-lived tokens where possible.
## Customize for your own server
This is a very generic implementation where it allows for complete introspection and for your users to do whatever (including mutations). If you need a more specific implementation I'd suggest to just create your own MCP and lock down tool calling for clients to only input specific query fields and/or variables. You can use this as a reference.
