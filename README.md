# mcp-graphql-enhanced
[![Glama](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced/badge)](https://glama.ai/mcp/servers/@letoribo/mcp-graphql-enhanced)
[![mcp-graphql-enhanced MCP server](https://glama.ai/mcp/servers/letoribo/mcp-graphql-enhanced/badges/score.svg)](https://glama.ai/mcp/servers/letoribo/mcp-graphql-enhanced)[![smithery badge](https://smithery.ai/badge/letoribo/mcp-graphql-enhanced)](https://smithery.ai/servers/letoribo/mcp-graphql-enhanced)
An **enhanced MCP (Model Context Protocol) server for GraphQL** that fixes real-world interoperability issues between LLMs and GraphQL APIs.
> Drop-in replacement for `mcp-graphql` — with dynamic headers, robust variables parsing, and zero breaking changes.

#### 🎯 What is mcp-graphql-enhanced?
`mcp-graphql-enhanced` is a high-performance, federated GraphQL gateway designed to act as a workhorse for LLM agents. It bridges the gap between massive, complex GraphQL ecosystems and the context-limited environment of AI assistants. Unlike standard "all-or-nothing" introspection tools that crash under the weight of large schemas (like GitHub's or enterprise-grade Neo4j graphs), this server provides surgical control over how your agent perceives and interacts with your data.

#### 💡 Why do you need it?
If you have ever seen the`<error>Tool result is too large</error>`while trying to introspect your API, you are already hitting the limits of standard MCP implementations. Here is why mcp-graphql-enhanced is the industry-standard choice for professional environments:

Avoid the 1MB Ceiling: It shifts the responsibility for scope from the server to the caller. Instead of a unilateral "everything or nothing" dump, you get granular control via typeNames and typeDepth parameters.

Surgical Precision: You can selectively introspect only the nodes you need (e.g., Repository, User, or Message), keeping your context window clean and your LLM focused.

Predictability over Immunity: It doesn't promise "unlimited" capacity—it promises predictability. In enterprise systems, you need a tool that lets you navigate the graph surgically and fail predictably if you overstep, rather than a "black box" that dies on you the moment the schema grows.

Proof of Performance: See a real-world demonstration of the gateway bypassing standard architectural limits during a live diagnostic test against the GitHub API:
🔗 Diagnostic Case Study: Scoped vs. Monolithic Introspection ([Shared Chat](https://claude.ai/share/5b845f72-809a-42ee-8083-361314126069))

## 💬 Community & Support

Join the conversation! If you have questions about using this bridge with Neo4j, Discord data graphs, or GraphQL in general, come hang out with us:

* **Discord Channel:** [#mcp-graphql-enhanced](https://discord.com/channels/625400653321076807/1480510460339159184)
* **Server:** The official **GraphQL Discord**

This is the best place to share your feedback, report issues, or suggest new "enhanced" features for the bridge.

## ✨ Key Enhancements
* ✅ **Built-in GraphiQL IDE** — Visual playground at / (or /graphql, /graphiql) with pre-configured headers for instant testing and introspection.
* ✅ **Dual Transport** — Supports both **STDIO** (for local CLI/client tools) and **HTTP/JSON-RPC** (for external/browser clients).
* ✅ **Dynamic headers** — pass `Authorization`, `X-API-Key`, etc., via tool arguments (no config restarts)
* ✅ **Robust variables parsing** — fixes `“Query variables must be a null or an object”` error
* ✅ **Smart introspection** — supports filtered requests (via typeNames) and recursive depth control (via typeDepth) to minimize LLM context noise and optimize schema exploration.
* ✅ **Full MCP compatibility** — works with **Claude Desktop**, **Groq Desktop**, **Glama** and any standard MCP client
* ✅ **Secure by default** — mutations disabled unless explicitly enabled
* ✅ **Dynamic Schema Evolution** — Smart diagnostics and gap analysis for servers that regenerate GraphQL types on-the-fly (like Neo4j).
* ✅ **Deep Observability** — Automatic Cypher extraction and cleaning from GraphQL extensions.

## 🚀 Federated Multi-Node Architecture (v3.9.1+)
The server operates as a Federated GraphQL Gateway, merging independent nodes into a unified system.

*   **Zero Breaking Changes**: If you provide a single URL in `ENDPOINT`, the server behaves exactly as before.
*   **Federated Introspection**: Scans all endpoints simultaneously to build a global capability map.
*   **Smart Aggregation**: When multiple comma-separated URLs are provided, the server broadcasts queries and merges results using universal deep deduplication (object-level).
*   **Conflict Handling**: Identifies structural differences in identical Type names across nodes and exposes them uniquely.
*   **Bypass Free Tier Limits**: Perfect for users of "Free Tier" cloud databases (like Neo4j Aura). You can split your data across multiple free instances and use this bridge to query them as a **single unified graph**, effectively bypassing entity count limitations.

#### Proof of Concept:
See a real-world demonstration of the federated query synthesis in action, where the agent aggregates live Discord data with historical Neo4j insights:
🔗 Live Federation Analysis ([Shared Chat](https://claude.ai/share/69a1f8dc-10f0-4c5b-bfe2-267f1294851a))

#### 💡 Use Case: Bridging WSL and Windows (PowerShell)
A common challenge for Windows developers is the network isolation between the Windows Subsystem for Linux (WSL) and the host OS. This feature allows you to bridge these two worlds into a "Unified Nervous System".  

Example configuration for Claude Desktop:
```bash
{
  "ENDPOINT": "http://DESKTOP-NAME.local:2311/graphql,http://127.0.0.1:4000/graphql"
}
```
*   **Hybrid Ecosystem**: Seamlessly query and aggregate data across Windows-native processes (PowerShell) and Linux-based environments (WSL).  

*   **mDNS Support**: By using .local addresses, the bridge automatically resolves the host machine's IP from within the WSL environment.  

*   **Transparent Aggregation**: The AI assistant interacts with a single unified schema, unaware that the data is being fetched from different operating systems simultaneously.

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

* **Endpoint:** `http://localhost:6274/` (or /graphql, /graphiql)
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
#### Test the health check (assuming the server bound to the default or found the next available port)
```bash
curl http://localhost:6274/health
```
#### Testing the JSON-RPC Transport
```
curl -X POST http://localhost:6274/mcp  \
-H "Content-Type: application/json"  \
-d '{
  "jsonrpc":"2.0",
  "method":"tools/list",
  "params":{},
  "id":1
}'

curl -X POST http://localhost:6274/mcp \
-H "Content-Type: application/json" \
-d '{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "introspect-schema",
    "arguments": {}
  },
  "id": 2
}'

curl -X POST http://localhost:6274/mcp \
-H "Content-Type: application/json" \
-d '{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "introspect-schema",
    "arguments": {
      "typeNames": ["User", "Message"]
    }
  },
  "id": 3
}'

curl -X POST http://localhost:6274/mcp \
-H "Content-Type: application/json" \
-d '{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "introspect-schema",
    "arguments": {
      "typeNames": ["Message"],
      "typeDepth": 4
    }
  },
  "id": 4
}'

curl -X POST http://localhost:6274/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "query-graphql",
      "arguments": {
        "query": "{ guildChannels(guild_id: \"1312302100125843476\") { name id topic } }"
      }
    },
    "id": 5
  }'
```
 (using port 6275 if 6274 was busy)
```
curl -X POST http://localhost:6275/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"query-graphql","params":{"query":"query { __typename }"},"id":1}'
```

#### 🔍 Use the official MCP Inspector to test your server live:
```
npx @modelcontextprotocol/inspector \
  -e ENDPOINT=https://api.example.com/graphql \
  npx @letoribo/mcp-graphql-enhanced
```
### Environment Variables (Breaking change in 1.0.0)
> **Note:** As of version 1.0.0, command line arguments have been replaced with environment variables.

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `ENDPOINT` | GraphQL endpoint(s). Supports comma-separated list for Multi-Node Architecture. | `https://mcp-discord.vercel.app/api/graphiql` |
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
### 🚀 Examples
#### 1. Quick Start
Basic startup using the default endpoint.
```bash
npx @letoribo/mcp-graphql-enhanced
```
#### 2. Configuration & Authentication
Running with custom headers (e.g., for API keys or Bearer tokens).
```
ENDPOINT=https://api.example.com/graphql \
HEADERS='{"Authorization":"Bearer xyz"}' \
npx @letoribo/mcp-graphql-enhanced
```
#### 3. Advanced Integration
Using a local .graphql file If you want to work with a local schema without querying the API directly.
```
ENDPOINT=http://localhost:3000/graphql \
SCHEMA=./schema.graphql \
npx @letoribo/mcp-graphql-enhanced
```
Enabling Mutations (Writes) Mutations are disabled by default for security. To enable them:
```
ENDPOINT=http://localhost:3000/graphql \
ALLOW_MUTATIONS=true \
npx @letoribo/mcp-graphql-enhanced
```
Multi-Node Architecture (Federation) Aggregating data from multiple sources into a single unified graph.
```
ENDPOINT=https://mcp-discord.vercel.app/api/graphiql,https://mcp-neo4j-discord.vercel.app/api/graphiql \
npx @letoribo/mcp-graphql-enhanced
```
#### 4. Customizing Environment
Example of port configuration and development mode settings.
```
# Change the HTTP port
MCP_PORT=8080 npx @letoribo/mcp-graphql-enhanced

# Test targeted introspection and explore the schema visually:
ENDPOINT=https://api.github.com/graphql \
HEADERS='{"Authorization":"Bearer YOUR_GITHUB_TOKEN"}' \
ENABLE_HTTP=true \
npx @letoribo/mcp-graphql-enhanced

# Then visit http://localhost:6274/graphiql
```
#### 5. Interactive Launch with mcpgql (Recommended)
If you want to skip manual environment variable setup, use our CLI tool available on [npm](https://www.npmjs.com/package/@letoribo/mcpgql).
If installed globally (`npm install -g @letoribo/mcpgql`), simply run:
```
mcpgql
```
Alternatively, you can run it without global installation using:
```
npx @letoribo/mcpgql@latest
```
- **Zero-config start**: Automatic discovery and template initialization.
- **Interactive selection**: Toggle multiple endpoints and permissions on the fly.
- **Bridge mode**: Automatically handles the Federated Bridge setup on localhost:6274.  
#### 6. Integration via Smithery CLI
Smithery provides a powerful way to manage your MCP servers, handle authentication, and interact with tools directly from your terminal
```
# 1. Install Smithery CLI
npm install -g smithery

# 2. Create a namespace
smithery namespace create {your-namespace}

# 3. Add the server
smithery mcp add letoribo/mcp-graphql-enhanced

# 4. Interact with tools
smithery tool list {connection}
smithery tool call {connection} {tool_name} '{"key": "value"}'

E.g.
smithery tool call letoribo-mcp-graphql-enhanced introspect-schema
smithery tool call letoribo-mcp-graphql-enhanced introspect-schema '{"typeNames": ["Guild", "Message", "User"]}'
smithery tool call letoribo-mcp-graphql-enhanced introspect-schema '{"typeNames": ["McpServer"], "typeDepth": 2}'
smithery tool call letoribo-mcp-graphql-enhanced query-graphql '{"query": "{ guildChannels(guild_id: \"1312302100125843476\") { name id topic } }"}'
smithery tool call letoribo-mcp-graphql-enhanced query-graphql '{"query": "{ searchMcpServers(q: \"mcp-remote\", limit: 50) { id name namespace description environmentVariablesJsonSchema { properties required } } }"}'
```
### ☁️ Deploy to Cloud
This server is fully containerized and optimized for long-running processes.
### Recommended Hosting
| Platform | Recommended PORT | Notes |
| :--- | :--- | :--- |
| ***Railway*** | `8080` | Set `PORT` in Variables and update Networking ingress port. |
| ***Render*** | `10000` | Set `PORT` in Environment Variables. |

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new?template=https://github.com/letoribo/mcp-graphql-enhanced)

**Important:** 
* For hosted environments, you **must** set the environment variable `ENABLE_HTTP=true` in your platform's settings to ensure the HTTP transport layer is active.
* Ensure your hosting provider's public networking settings are configured to route traffic to the port defined in your `PORT` environment variable to avoid `502 Bad Gateway` errors.

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
1. **introspect-schema**: Retrieves the GraphQL schema or a subset. Use this first to understand the graph structure.
  - **Arguments:**
    - `typeNames` *(optional, array)*: List of specific types to introspect (e.g., `["User", "Message"]`). Reduces noise by returning only relevant parts of the graph.
    - `typeDepth` *(optional, number)*: Controls the recursion level of nested fields (Default: `2`). 
      > **Note:** `typeDepth` is only functional when `typeNames` is provided to narrow the scope.
  - **Note:** Filtered introspection is only available when querying a live GraphQL endpoint.
2. **query-graphql**: Execute GraphQL queries against the endpoint. By default, mutations are disabled unless `ALLOW_MUTATIONS` is set to `true`.
## Security Considerations
Mutations are disabled by default to prevent unintended data changes. Always validate HEADERS and SCHEMA inputs in production. Use HTTPS endpoints and short-lived tokens where possible.
## Customize for your own server
This is a very generic implementation where it allows for complete introspection and for your users to do whatever (including mutations). If you need a more specific implementation I'd suggest to just create your own MCP and lock down tool calling for clients to only input specific query fields and/or variables. You can use this as a reference.
