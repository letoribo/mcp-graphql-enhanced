import { test } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateRequest,
    isAllowedOrigin,
    isLoopbackBind,
    isLoopbackHostHeader,
    isSameOrigin,
    resolveBindHost,
} from "./http-guard.js";

const LOOP = "127.0.0.1";
const PUB = "0.0.0.0";
const LHOST = "127.0.0.1:6279";

const ev = (method: string, origin: string | undefined, hostHeader: string | undefined, bindHost: string) =>
    evaluateRequest({ method, origin, hostHeader, bindHost });

test("resolveBindHost", () => {
    assert.equal(resolveBindHost({ portEnv: undefined, inDocker: false }), "127.0.0.1");
    assert.equal(resolveBindHost({ portEnv: "", inDocker: false }), "127.0.0.1");
    assert.equal(resolveBindHost({ portEnv: "10000", inDocker: false }), "0.0.0.0");
    assert.equal(resolveBindHost({ portEnv: undefined, inDocker: true }), "0.0.0.0");
    assert.equal(resolveBindHost({ portEnv: "8080", inDocker: true }), "0.0.0.0");
});

test("isLoopbackBind", () => {
    assert.ok(isLoopbackBind("127.0.0.1"));
    assert.ok(isLoopbackBind("::1"));
    assert.ok(!isLoopbackBind("0.0.0.0"));
});

test("isAllowedOrigin: allowlisted origins", () => {
    for (const o of [
        "http://localhost:5173",
        "http://localhost",
        "https://localhost:8443",
        "http://127.0.0.1:6279",
        "https://127.0.0.1",
        "http://[::1]:8080",
        "app://app",
    ]) {
        assert.ok(isAllowedOrigin(o), o);
    }
});

test("isAllowedOrigin: rejects null, file, foreign and lookalikes", () => {
    for (const o of [
        undefined,
        "",
        "null",
        "file://",
        "file:///etc/passwd",
        "https://evil.example",
        "http://localhost.evil.com",
        "http://127.0.0.1.evil.com",
        "http://evil.com/localhost",
        "http://localhost@evil.com",
        "http://evil.com@localhost",
        "http://user:pass@localhost:5173",
        "http://localhost:5173/",
        "http://localhost:5173/path",
        "ftp://localhost",
        "ws://localhost:5173",
        "app://app/path",
        "app://user@app",
        "app://",
        "http://0.0.0.0:6279",
        "http://[::ffff:127.0.0.1]",
    ]) {
        assert.ok(!isAllowedOrigin(o), String(o));
    }
});

test("isSameOrigin", () => {
    assert.ok(isSameOrigin("https://x.onrender.com", "x.onrender.com"));
    assert.ok(isSameOrigin("http://X.onrender.com", "x.ONRENDER.com"));
    assert.ok(isSameOrigin("https://x.example:8443", "x.example:8443"));
    assert.ok(!isSameOrigin("https://x.onrender.com", "y.onrender.com"));
    assert.ok(!isSameOrigin("https://x.example:8443", "x.example"));
    assert.ok(!isSameOrigin("null", "x.onrender.com"));
    assert.ok(!isSameOrigin("https://x.onrender.com", undefined));
    assert.ok(!isSameOrigin("https://evil@x.onrender.com", "x.onrender.com"));
});

test("isLoopbackHostHeader", () => {
    for (const h of ["localhost", "localhost:6279", "LOCALHOST:6279", "127.0.0.1", "127.0.0.1:6279", "[::1]", "[::1]:6279"]) {
        assert.ok(isLoopbackHostHeader(h), h);
    }
    for (const h of [undefined, "", "evil.example", "localhost.evil.com", "127.0.0.1.evil.com", "localhost@evil.com", "evil.com:6279", "0.0.0.0:6279"]) {
        assert.ok(!isLoopbackHostHeader(h), String(h));
    }
});

test("evaluateRequest: allowed origins echo ACAO", () => {
    for (const o of ["http://localhost:5173", "http://127.0.0.1:6279", "http://[::1]:8080", "app://app"]) {
        for (const m of ["POST", "OPTIONS", "GET"]) {
            assert.deepEqual(ev(m, o, LHOST, LOOP), { allowOrigin: o, reject: null }, `${m} ${o}`);
        }
    }
});

test("evaluateRequest: foreign origin", () => {
    const o = "https://evil.example";
    for (const bind of [LOOP, PUB]) {
        const host = bind === LOOP ? LHOST : "x.onrender.com";
        assert.equal(ev("POST", o, host, bind).reject?.status, 403);
        assert.equal(ev("POST", o, host, bind).allowOrigin, null);
        assert.equal(ev("OPTIONS", o, host, bind).reject?.status, 403);
        assert.equal(ev("OPTIONS", o, host, bind).allowOrigin, null);
        assert.equal(ev("PUT", o, host, bind).reject?.status, 403);
        assert.deepEqual(ev("GET", o, host, bind), { allowOrigin: null, reject: null });
        assert.deepEqual(ev("HEAD", o, host, bind), { allowOrigin: null, reject: null });
    }
});

test("evaluateRequest: null and file:// rejected on loopback and public bind", () => {
    for (const o of ["null", "file://"]) {
        assert.equal(ev("POST", o, LHOST, LOOP).reject?.status, 403);
        assert.equal(ev("POST", o, "x.onrender.com", PUB).reject?.status, 403);
        assert.equal(ev("OPTIONS", o, LHOST, LOOP).reject?.status, 403);
        assert.equal(ev("GET", o, LHOST, LOOP).allowOrigin, null);
    }
});

test("evaluateRequest: lookalike origins rejected", () => {
    for (const o of ["http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://evil.com/localhost", "http://localhost@evil.com"]) {
        assert.equal(ev("POST", o, LHOST, LOOP).reject?.status, 403, o);
    }
});

test("evaluateRequest: same-origin on public bind allowed", () => {
    const o = "https://x.onrender.com";
    assert.deepEqual(ev("POST", o, "x.onrender.com", PUB), { allowOrigin: o, reject: null });
    assert.equal(ev("POST", o, "y.onrender.com", PUB).reject?.status, 403);
});

test("evaluateRequest: no Origin allowed on both binds without ACAO", () => {
    assert.deepEqual(ev("POST", undefined, LHOST, LOOP), { allowOrigin: null, reject: null });
    assert.deepEqual(ev("POST", undefined, "x.onrender.com", PUB), { allowOrigin: null, reject: null });
    assert.deepEqual(ev("OPTIONS", undefined, LHOST, LOOP), { allowOrigin: null, reject: null });
});

test("evaluateRequest: loopback bind rejects non-loopback Host (DNS rebinding)", () => {
    for (const m of ["GET", "POST", "OPTIONS"]) {
        assert.equal(ev(m, undefined, "evil.example", LOOP).reject?.status, 403, m);
        assert.equal(ev(m, "http://localhost:5173", "evil.example:6279", LOOP).reject?.status, 403, m);
    }
    assert.equal(ev("POST", undefined, undefined, LOOP).reject?.status, 403);
    // Public bind does not check Host.
    assert.equal(ev("POST", undefined, "evil.example", PUB).reject, null);
});
