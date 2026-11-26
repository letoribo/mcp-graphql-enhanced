import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isDocker } from "./helpers/container.js";

const ROOT = path.resolve(__dirname, "..");
const CANARY = "Bearer CANARY-TOKEN-6f3a9c";

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}

function request(port: number, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }, host = "127.0.0.1"): Promise<Res> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, method: opts.method, path: opts.path, headers: opts.headers, agent: false }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(new Error("timeout")));
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const postMcp = (port: number, headers: Record<string, string> = {}, body = INIT) =>
    request(port, { method: "POST", path: "/mcp", headers: { "Content-Type": "application/json", ...headers }, body });

// Never bind 0.0.0.0 in tests: inside Docker the server would bind publicly.
describe("HTTP transport security (real server)", { skip: isDocker() ? "running in Docker" : false }, () => {
    let child: ChildProcess;
    let port: number;
    let stderr = "";

    before(async () => {
        port = await freePort();
        const env: NodeJS.ProcessEnv = { ...process.env, ENABLE_HTTP: "true", MCP_PORT: String(port), HEADERS: JSON.stringify({ Authorization: CANARY }) };
        for (const k of ["PORT", "ENDPOINT", "SCHEMA", "MCP_INSPECTOR", "INSPECTOR_PORT", "INSPECTOR_URL"]) delete env[k];

        // Load tsx in-process (no wrapper child) so killing `child` kills the server itself.
        child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "index.ts")], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout!.resume();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr}`)), 30000);
            child.stderr!.on("data", (c) => {
                stderr += c;
                if (/Federated Bridge active on/.test(stderr)) { clearTimeout(timer); resolve(); }
            });
            child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${stderr}`)); });
        });
    });

    after(async () => {
        if (!child || child.exitCode !== null) return;
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGKILL");
        await exited;
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
    });

    test("binds to 127.0.0.1 only", async () => {
        assert.match(stderr, new RegExp(`Federated Bridge active on 127\\.0\\.0\\.1:${port}`));
        assert.doesNotMatch(stderr, /bound publicly/);
        const lan = Object.values(os.networkInterfaces()).flat()
            .find((i) => i && i.family === "IPv4" && !i.internal);
        if (lan) {
            await assert.rejects(request(port, { method: "GET", path: "/health" }, lan.address), /ECONNREFUSED/);
        }
    });

    test("POST /mcp with no Origin -> 200 (CLI / mcp-graphiql bridge)", async () => {
        const r = await postMcp(port);
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.body).result.serverInfo.name, "mcp-graphql-enhanced");
        assert.equal(r.headers["access-control-allow-origin"], undefined);
        assert.equal(r.headers["vary"], "Origin");
    });

    for (const origin of ["http://localhost:5173", "app://app"]) {
        test(`POST /mcp from ${origin} -> 200 + ACAO echo`, async () => {
            const r = await postMcp(port, { Origin: origin });
            assert.equal(r.status, 200);
            assert.equal(r.headers["access-control-allow-origin"], origin);
            assert.equal(r.headers["vary"], "Origin");
        });
    }

    for (const origin of ["https://evil.example", "null"]) {
        test(`POST /mcp from ${origin} -> 403, no ACAO`, async () => {
            const r = await postMcp(port, { Origin: origin });
            assert.equal(r.status, 403);
            assert.equal(r.headers["access-control-allow-origin"], undefined);
            assert.ok(JSON.parse(r.body).error);
        });
    }

    test("text/plain simple-request POST from evil origin -> 403", async () => {
        const r = await request(port, { method: "POST", path: "/mcp", headers: { "Content-Type": "text/plain", Origin: "https://evil.example" }, body: INIT });
        assert.equal(r.status, 403);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
    });

    test("OPTIONS preflight from localhost:5173 -> 204 with ACAO", async () => {
        const r = await request(port, { method: "OPTIONS", path: "/mcp", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
        assert.equal(r.status, 204);
        assert.equal(r.headers["access-control-allow-origin"], "http://localhost:5173");
        assert.match(String(r.headers["access-control-allow-methods"]), /POST/);
        assert.match(String(r.headers["access-control-allow-headers"]), /Content-Type/);
    });

    test("OPTIONS preflight from evil -> 403, no ACAO", async () => {
        const r = await request(port, { method: "OPTIONS", path: "/mcp", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
        assert.equal(r.status, 403);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
    });

    test("POST /graphql from evil -> 403", async () => {
        const r = await request(port, { method: "POST", path: "/graphql", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ query: "{ __typename }" }) });
        assert.equal(r.status, 403);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
    });

    test("Host: evil.example with no Origin -> 403 (DNS rebinding)", async () => {
        const r = await postMcp(port, { Host: "evil.example" });
        assert.equal(r.status, 403);
        const g = await request(port, { method: "GET", path: "/graphiql", headers: { Host: `evil.example:${port}` } });
        assert.equal(g.status, 403);
    });

    test("GET /graphiql -> 200 without env header values", async () => {
        const r = await request(port, { method: "GET", path: "/graphiql" });
        assert.equal(r.status, 200);
        assert.match(r.body, /GraphiQL/);
        assert.ok(!r.body.includes("CANARY-TOKEN"), "GraphiQL page leaked env HEADERS");
    });

    test("GET /graphiql from evil origin -> 200 but no ACAO", async () => {
        const r = await request(port, { method: "GET", path: "/graphiql", headers: { Origin: "https://evil.example" } });
        assert.equal(r.status, 200);
        assert.equal(r.headers["access-control-allow-origin"], undefined);
    });
});
