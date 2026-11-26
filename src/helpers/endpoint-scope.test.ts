import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
    fetchFollowingTrustedRedirects,
    isConfiguredEndpoint,
    normalizeEndpointUrl,
    parseEndpointList,
    selectOutboundHeaders,
    withoutBodyHeaders,
} from "./endpoint-scope.js";

const CONFIGURED = ["https://api.example.com/graphql"];
const OP = { Authorization: "Bearer OPERATOR-CANARY-91d2" };

test("normalizeEndpointUrl", () => {
    assert.equal(normalizeEndpointUrl("https://API.Example.com:443/graphql/#x"), "https://api.example.com/graphql");
    assert.equal(normalizeEndpointUrl("HTTP://localhost:80/"), "http://localhost");
    assert.equal(normalizeEndpointUrl("http://localhost:4000/a?b=1"), "http://localhost:4000/a");
    assert.equal(normalizeEndpointUrl("  https://user:pw@api.example.com/graphql  "), "https://api.example.com/graphql");
    assert.equal(normalizeEndpointUrl("not a url"), null);
    assert.equal(normalizeEndpointUrl("file:///etc/passwd"), null);
    assert.equal(normalizeEndpointUrl(""), null);
    assert.equal(normalizeEndpointUrl(undefined), null);
});

test("parseEndpointList", () => {
    assert.deepEqual(parseEndpointList(" http://a/graphql , http://b/graphql ,"), ["http://a/graphql", "http://b/graphql"]);
    assert.deepEqual(parseEndpointList(""), []);
    assert.deepEqual(parseEndpointList(undefined), []);
});

test("isConfiguredEndpoint: equivalent variants match", () => {
    for (const v of [
        "https://api.example.com/graphql",
        "https://api.example.com/graphql/",
        "https://API.EXAMPLE.COM/graphql",
        "HTTPS://api.example.com/graphql",
        "https://api.example.com:443/graphql",
        "https://api.example.com/graphql#frag",
        "https://api.example.com/graphql/#frag",
    ]) {
        assert.equal(isConfiguredEndpoint(v, CONFIGURED), true, v);
    }
    assert.equal(isConfiguredEndpoint("http://localhost/graphql", ["http://localhost:80/graphql/"]), true);
});

test("isConfiguredEndpoint: lookalikes do not match", () => {
    for (const v of [
        "https://api.example.com.evil.test/graphql",
        "https://evil.test/api.example.com/graphql",
        "https://api.example.com@evil.test/graphql",
        "https://evilapi.example.com/graphql",
        "https://api.example.co/graphql",
        "http://api.example.com/graphql",
        "https://api.example.com:8443/graphql",
        "https://api.example.com/graphql2",
        "https://api.example.com/graphql/v2",
        "https://api.example.com/GraphQL",
        "https://api.example.com/",
        "https://evil.test/graphql?u=https://api.example.com/graphql",
        "not a url",
        "",
    ]) {
        assert.equal(isConfiguredEndpoint(v, CONFIGURED), false, v);
    }
    assert.equal(isConfiguredEndpoint("https://api.example.com/graphql", []), false);
});

test("isConfiguredEndpoint: matches any entry of a list", () => {
    const list = parseEndpointList("https://a.example/graphql,https://b.example/gql/");
    assert.equal(isConfiguredEndpoint("https://B.example/gql", list), true);
    assert.equal(isConfiguredEndpoint("https://a.example/graphql/", list), true);
    assert.equal(isConfiguredEndpoint("https://c.example/graphql", list), false);
});

test("selectOutboundHeaders", () => {
    assert.deepEqual(
        selectOutboundHeaders("https://api.example.com/graphql/", CONFIGURED, OP, { "X-Call": "1" }),
        { ...OP, "X-Call": "1" }
    );
    assert.deepEqual(
        selectOutboundHeaders("https://evil.test/graphql", CONFIGURED, OP, { "X-Call": "1" }),
        { "X-Call": "1" }
    );
    assert.deepEqual(selectOutboundHeaders("https://evil.test/graphql", CONFIGURED, OP), {});
    assert.deepEqual(
        selectOutboundHeaders("https://evil.test/graphql", CONFIGURED, OP, { Authorization: "caller-token" }),
        { Authorization: "caller-token" }
    );
    assert.deepEqual(
        selectOutboundHeaders("https://api.example.com/graphql", CONFIGURED, OP, { Authorization: "caller-token" }),
        { Authorization: "caller-token" }
    );
});

test("withoutBodyHeaders", () => {
    assert.deepEqual(
        withoutBodyHeaders({ "Content-Type": "application/json", "content-length": "3", Authorization: "x", accept: "a" }),
        { Authorization: "x", accept: "a" }
    );
});

test("fetchFollowingTrustedRedirects follows only trusted Locations", async () => {
    type Hit = { method: string; path: string; auth?: string };
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            hits.push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
            const port = (server.address() as net.AddressInfo).port;
            const redirects: Record<string, [number, string]> = {
                "/to-trusted": [307, `http://127.0.0.1:${port}/trusted-2`],
                "/to-other": [302, `http://127.0.0.1:${port}/other`],
                "/post-302": [302, "/trusted-2"],
            };
            const r = redirects[req.url!];
            if (r) res.writeHead(r[0], { Location: r[1] });
            else res.writeHead(200);
            res.end();
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const trusted = [`${base}/to-trusted`, `${base}/to-other`, `${base}/post-302`, `${base}/trusted-2`];
    const init = { method: "POST", headers: { Authorization: OP.Authorization, "Content-Type": "application/json" }, body: "{}" };
    try {
        let res = await fetchFollowingTrustedRedirects(`${base}/to-trusted`, init, trusted);
        assert.equal(res.status, 200);
        assert.deepEqual(hits.at(-1), { method: "POST", path: "/trusted-2", auth: OP.Authorization });

        hits.length = 0;
        res = await fetchFollowingTrustedRedirects(`${base}/to-other`, init, trusted);
        assert.equal(res.status, 302, "untrusted redirect is returned, not followed");
        assert.deepEqual(hits.map((h) => h.path), ["/to-other"]);

        hits.length = 0;
        res = await fetchFollowingTrustedRedirects(`${base}/post-302`, init, trusted);
        assert.equal(res.status, 200);
        assert.deepEqual(hits.at(-1), { method: "GET", path: "/trusted-2", auth: OP.Authorization });
    } finally {
        await new Promise((r) => server.close(r));
    }
});
