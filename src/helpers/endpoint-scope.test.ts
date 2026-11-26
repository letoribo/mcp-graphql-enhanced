import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isConfiguredEndpoint,
    normalizeEndpointUrl,
    parseEndpointList,
    selectOutboundHeaders,
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
