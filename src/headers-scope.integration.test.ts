import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { buildSchema, graphql } from "graphql";
import { isDocker } from "./helpers/container.js";

const ROOT = path.resolve(__dirname, "..");
// Distinctive, fake operator credential. Must only ever reach the configured endpoint.
const CANARY = "Bearer OPERATOR-CANARY-row16-7e41b0";
const CANARY_HDR = "x-operator-canary";
const CANARY_HDR_VAL = "OPCANARY-row16-55aa";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; query: string };
type Mock = { server: http.Server; port: number; seen: Seen[] };

const sdl = buildSchema("type Query { whoami: String }");
// Served when the request carries `x-schema: alt`, so a test can see whose schema ended up cached.
const altSdl = buildSchema("type Poisoned { x: String } type Query { whoami: String poisoned: Poisoned }");

// Optional per-request override: return a bodiless response instead of the GraphQL result.
type Behave = (s: Seen) => { status: number; headers?: Record<string, string> } | null;

function startMock(id: string, behave?: Behave): Promise<Mock> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            let query = "";
            try {
                query = req.method === "POST"
                    ? JSON.parse(body).query
                    : new URL(req.url!, "http://x").searchParams.get("query") || "";
            } catch { /* ignore */ }
            const entry = { method: req.method!, url: req.url!, headers: req.headers, query };
            seen.push(entry);
            const special = behave?.(entry);
            if (special) {
                res.writeHead(special.status, special.headers);
                res.end();
                return;
            }
            const schema = req.headers["x-schema"] === "alt" ? altSdl : sdl;
            const result = await graphql({ schema, source: query, rootValue: { whoami: id } });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        });
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port, seen }));
    });
}

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

function callTool(port: number, name: string, args: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "Content-Type": "application/json" }, agent: false }, (res) => {
            let out = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (out += c));
            res.on("end", () => {
                try { resolve(JSON.parse(out).result); } catch (e) { reject(new Error(`bad response: ${out}`)); }
            });
        });
        req.on("error", reject);
        req.setTimeout(20000, () => req.destroy(new Error("timeout")));
        req.end(body);
    });
}

async function whoami(port: number, args: Record<string, unknown> = {}): Promise<string> {
    const r = await callTool(port, "query-graphql", { query: "query { whoami }", ...args });
    assert.ok(!r.isError, `tool error: ${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text).data.whoami;
}

const hasCanary = (s: Seen) => s.headers.authorization === CANARY || s.headers[CANARY_HDR] === CANARY_HDR_VAL;
const whoamiHits = (m: Mock, tag: string) => m.seen.filter((s) => s.headers["x-call"] === tag && s.query.includes("whoami"));

describe("env.HEADERS scoping and per-call endpoint isolation (real server)", { skip: isDocker() ? "running in Docker" : false }, () => {
    let child: ChildProcess;
    let port: number;
    let stderr = "";
    let A: Mock; // operator-configured endpoint
    let B: Mock; // caller-supplied override (stands in for an attacker URL)
    let urlA: string;
    let urlB: string;

    before(async () => {
        // A (configured) redirects non-introspection requests to B when the URL asks for it,
        // and returns 400 to POSTs carrying `x-post-fails` (forces the GET fallback).
        A = await startMock("A", (s) => {
            if (s.method === "POST" && s.headers["x-post-fails"]) return { status: 400 };
            if (s.url.includes("redirect-to-b") && !s.query.includes("__schema")) {
                return { status: 307, headers: { Location: `http://127.0.0.1:${B.port}/graphql` } };
            }
            return null;
        });
        B = await startMock("B");
        urlA = `http://localhost:${A.port}/graphql`;
        urlB = `http://127.0.0.1:${B.port}/graphql`;
        port = await freePort();
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ENABLE_HTTP: "true",
            MCP_PORT: String(port),
            ENDPOINT: urlA,
            HEADERS: JSON.stringify({ Authorization: CANARY, [CANARY_HDR]: CANARY_HDR_VAL }),
        };
        for (const k of ["PORT", "SCHEMA", "MCP_INSPECTOR", "INSPECTOR_PORT", "INSPECTOR_URL", "NAME"]) delete env[k];

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
        // Wait for the boot schema sync against A so default calls have a schema.
        const deadline = Date.now() + 20000;
        while (true) {
            const r = await callTool(port, "introspect-schema", {});
            if (!r.isError && /NODE: /.test(r.content?.[0]?.text || "")) break;
            if (Date.now() > deadline) throw new Error(`schema never loaded:\n${stderr}`);
            await new Promise((r) => setTimeout(r, 200));
        }
    });

    after(async () => {
        if (child && child.exitCode === null) {
            const exited = new Promise((r) => child.once("exit", r));
            child.kill("SIGKILL");
            await exited;
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
        }
        await Promise.all([A, B].filter(Boolean).map((m) => new Promise((r) => m.server.close(r))));
    });

    test("configured endpoint receives env.HEADERS", async () => {
        assert.equal(await whoami(port, { headers: JSON.stringify({ "X-Call": "default-1" }) }), "A");
        const hits = whoamiHits(A, "default-1");
        assert.equal(hits.length, 1);
        assert.equal(hits[0].headers.authorization, CANARY);
        assert.equal(hits[0].headers[CANARY_HDR], CANARY_HDR_VAL);
        assert.ok(A.seen.some((s) => s.query.includes("__schema") && hasCanary(s)), "boot introspection should carry env.HEADERS");
    });

    test("override endpoint gets per-call headers but never env.HEADERS", async () => {
        assert.equal(await whoami(port, { endpoint: urlB, headers: JSON.stringify({ "X-Call": "override-1" }) }), "B");
        const hits = whoamiHits(B, "override-1");
        assert.equal(hits.length, 1);
        assert.equal(hits[0].headers["x-call"], "override-1");
        assert.ok(B.seen.length > 1, "override introspection should have hit B");
        for (const s of B.seen) assert.ok(!hasCanary(s), `env.HEADERS leaked to override: ${s.method} ${s.url}`);
    });

    test("introspect-schema override gets per-call headers, no env.HEADERS, and does not clobber the default cache", async () => {
        const start = B.seen.length;
        const r = await callTool(port, "introspect-schema", { endpoint: urlB, headers: JSON.stringify({ "X-Call": "introspect-B" }) });
        assert.ok(!r.isError);
        assert.match(r.content[0].text, new RegExp(`NODE: ${urlB}`));
        const fresh = B.seen.slice(start);
        assert.ok(fresh.length > 0);
        for (const s of fresh) {
            assert.equal(s.headers["x-call"], "introspect-B");
            assert.ok(!hasCanary(s), "env.HEADERS leaked to introspect-schema override");
        }

        const def = await callTool(port, "introspect-schema", {});
        assert.match(def.content[0].text, new RegExp(`NODE: ${urlA}`));
        assert.doesNotMatch(def.content[0].text, new RegExp(String(B.port)));
    });

    test("after an override, a no-override call still uses the configured endpoint with env.HEADERS", async () => {
        await whoami(port, { endpoint: urlB, headers: JSON.stringify({ "X-Call": "override-2" }) });
        assert.equal(await whoami(port, { headers: JSON.stringify({ "X-Call": "default-2" }) }), "A");
        const hits = whoamiHits(A, "default-2");
        assert.equal(hits.length, 1);
        assert.ok(hasCanary(hits[0]));
        assert.equal(whoamiHits(B, "default-2").length, 0);
    });

    test("concurrent calls with different endpoints do not cross", async () => {
        const N = 16;
        const calls = Array.from({ length: N }, (_, i) => {
            const override = i % 2 === 1;
            const tag = `conc-${i}`;
            return whoami(port, { headers: JSON.stringify({ "X-Call": tag }), ...(override ? { endpoint: urlB } : {}) })
                .then((who) => ({ i, override, tag, who }));
        });
        const results = await Promise.all(calls);
        for (const { override, tag, who } of results) {
            assert.equal(who, override ? "B" : "A", tag);
            const [right, wrong] = override ? [B, A] : [A, B];
            assert.equal(whoamiHits(right, tag).length, 1, `${tag} missing at expected endpoint`);
            assert.equal(whoamiHits(wrong, tag).length, 0, `${tag} crossed to the other endpoint`);
            for (const s of whoamiHits(right, tag)) assert.equal(hasCanary(s), !override, tag);
        }
        for (const s of B.seen) assert.ok(!hasCanary(s), "env.HEADERS leaked to override under concurrency");
        // Default endpoint is still intact afterwards
        assert.equal(await whoami(port, { headers: JSON.stringify({ "X-Call": "post-conc" }) }), "A");
    });

    test("trailing-slash / case / hash variants of the configured endpoint still receive env.HEADERS", async () => {
        const variants = [
            `http://localhost:${A.port}/graphql/`,
            `HTTP://LocalHost:${A.port}/graphql`,
            `http://LOCALHOST:${A.port}/graphql/#frag`,
        ];
        for (const [i, v] of variants.entries()) {
            const tag = `variant-${i}`;
            assert.equal(await whoami(port, { endpoint: v, headers: JSON.stringify({ "X-Call": tag }) }), "A", v);
            const hits = whoamiHits(A, tag);
            assert.equal(hits.length, 1, v);
            assert.ok(hasCanary(hits[0]), `variant ${v} should receive env.HEADERS`);
        }
        // Lookalike on a different port (B) is not the configured endpoint
        await whoami(port, { endpoint: `http://localhost:${B.port}/graphql`, headers: JSON.stringify({ "X-Call": "lookalike" }) });
        assert.ok(!hasCanary(whoamiHits(B, "lookalike")[0]));
    });

    test("a redirect from the configured endpoint to another URL is not followed with env.HEADERS", async () => {
        // Query is ignored by endpoint matching, so this target is "configured" and gets env.HEADERS.
        const target = `${urlA}?redirect-to-b=1`;
        const r = await callTool(port, "query-graphql", { query: "query { whoami }", endpoint: target, headers: JSON.stringify({ "X-Call": "redir-q" }) });
        const atA = whoamiHits(A, "redir-q");
        assert.ok(atA.length > 0, "configured endpoint should have been called");
        assert.ok(atA.every(hasCanary), "configured endpoint should still get env.HEADERS");
        assert.equal(whoamiHits(B, "redir-q").length, 0, "redirect to an unconfigured URL must not be followed");
        assert.doesNotMatch(r.content?.[0]?.text || "", /"whoami":\s*"B"/);
        for (const s of B.seen) assert.ok(!hasCanary(s), `env.HEADERS leaked via redirect: ${s.method} ${s.url}`);
    });

    test("explicit endpoint equal to the configured URL is request-scoped and does not rewrite the cache", async () => {
        const alt = (tag: string) => JSON.stringify({ "X-Call": tag, "X-Schema": "alt" });
        const r = await callTool(port, "introspect-schema", { endpoint: urlA, headers: alt("explicit-A") });
        assert.ok(!r.isError, r.content?.[0]?.text);
        assert.match(r.content[0].text, /Poisoned/, "the scoped call should see its own schema");

        const q = await callTool(port, "query-graphql", { query: "query { whoami }", endpoint: urlA, headers: alt("explicit-A-q") });
        assert.ok(!q.isError, q.content?.[0]?.text);

        // A no-override query is pruned against the module cache: `poisoned` survives only if
        // the explicit-endpoint call above wrote its schema there.
        await callTool(port, "query-graphql", { query: "query { whoami poisoned { x } }", headers: JSON.stringify({ "X-Call": "after-explicit" }) });
        const after = whoamiHits(A, "after-explicit");
        assert.equal(after.length, 1);
        assert.doesNotMatch(after[0].query, /poisoned/, "explicit-endpoint call wrote its schema into the module cache");

        const def = await callTool(port, "introspect-schema", {});
        assert.match(def.content[0].text, new RegExp(`NODE: ${urlA}`));
        assert.doesNotMatch(def.content[0].text, /Poisoned/, "explicit-endpoint call wrote its schema into the module cache");
    });

    test("GET fallbacks send the same headers as the POST", async () => {
        const hdrs = JSON.stringify({ "X-Call": "get-fb", "X-Post-Fails": "1" });
        const r = await callTool(port, "introspect-schema", { endpoint: urlA, headers: hdrs });
        assert.ok(!r.isError, r.content?.[0]?.text);
        assert.equal(await whoami(port, { endpoint: urlA, headers: hdrs }), "A");

        const gets = A.seen.filter((s) => s.method === "GET" && s.headers["x-call"] === "get-fb");
        assert.ok(gets.some((s) => s.query.includes("__schema")), "introspection GET fallback should carry per-call headers");
        assert.ok(gets.some((s) => s.query.includes("whoami")), "query GET fallback should carry per-call headers");
        for (const s of gets) assert.ok(hasCanary(s), "GET fallback to the configured endpoint should carry env.HEADERS");
    });
});
