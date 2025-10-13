# mcp-graphql-enhanced

[![Smithery](https://smithery.ai/badge/mcp-graphql-enhanced)](https://smithery.ai/server/mcp-graphql-enhanced)
[![Glama](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced)](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced)

An **enhanced MCP (Model Context Protocol) server for GraphQL** that fixes real-world interoperability issues between LLMs and GraphQL APIs.

> Drop-in replacement for `mcp-graphql` — with dynamic headers, robust variables parsing, and zero breaking changes.

## ✨ Key Enhancements

- ✅ **Dynamic headers** — pass `Authorization`, `X-API-Key`, etc., via tool arguments (no config restarts)
- ✅ **Robust variables parsing** — fixes `“Query variables must be a null or an object”` error
- ✅ **Full MCP compatibility** — works with **Claude Desktop**, **Cursor**, **Glama**, and **Smithery**
- ✅ **Secure by default** — mutations disabled unless explicitly enabled

## 🔍 Debug & Inspect

Use the official MCP Inspector to test your server live:

```bash
npx @modelcontextprotocol/inspector \
  -e ENDPOINT=https://api.example.com/graphql \
  npx mcp-graphql-enhanced --debug
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
ENDPOINT=http://localhost:3000/graphql npx mcp-graphql-enhanced

# With auth header
ENDPOINT=https://api.example.com/graphql \
HEADERS='{"Authorization":"Bearer xyz"}' \
npx mcp-graphql-enhanced

# Enable mutations
ENDPOINT=http://localhost:3000/graphql \
ALLOW_MUTATIONS=true \
npx mcp-graphql-enhanced

# Use local schema file
ENDPOINT=http://localhost:3000/graphql \
SCHEMA=./schema.graphql \
npx mcp-graphql-enhanced
```

## Resources

- **graphql-schema**: The server exposes the GraphQL schema as a resource that clients can access. This is either the local schema file, a schema file hosted at a URL, or based on an introspection query.

## Available Tools

The server provides two main tools:

1. **introspect-schema**: This tool retrieves the GraphQL schema. Use this first if you don't have access to the schema as a resource.
This uses either the local schema file, a schema file hosted at a URL, or an introspection query.

2. **query-graphql**: Execute GraphQL queries against the endpoint. By default, mutations are disabled unless `ALLOW_MUTATIONS` is set to `true`.

## Installation

### Installing via Smithery

To install GraphQL MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/mcp-graphql-enhanced):

```bash
npx -y @smithery/cli install mcp-graphql-enhanced --client claude
```

### Installing Manually

It can be manually installed to Claude:
```json
{
    "mcpServers": {
        "mcp-graphql": {
            "command": "npx",
            "args": ["mcp-graphql-enhanced"],
            "env": {
                "ENDPOINT": "https://your-api.com/graphql"
            }
        }
    }
}
```

## Security Considerations

Mutations are disabled by default to prevent unintended data changes. Always validate HEADERS and SCHEMA inputs in production. Use HTTPS endpoints and short-lived tokens where possible.
## Customize for your own server

This is a very generic implementation where it allows for complete introspection and for your users to do whatever (including mutations). If you need a more specific implementation I'd suggest to just create your own MCP and lock down tool calling for clients to only input specific query fields and/or variables. You can use this as a reference.
