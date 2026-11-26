/**
 * HTTP transport guard: bind-address selection, CORS allowlist and
 * DNS-rebinding protection. All functions are pure (no env reads) so they can
 * be unit-tested directly.
 */

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Loopback by default. Bind publicly only when the platform assigns PORT
 * (Render/Railway) or when running inside Docker (port mapping needs 0.0.0.0).
 */
export function resolveBindHost({ portEnv, inDocker }: { portEnv?: string; inDocker: boolean }): string {
    if ((portEnv && portEnv.trim().length > 0) || inDocker) return "0.0.0.0";
    return "127.0.0.1";
}

export function isLoopbackBind(host: string): boolean {
    return LOOPBACK_BIND_HOSTS.has(host);
}

function parseOrigin(origin: string): URL | null {
    try {
        return new URL(origin);
    } catch {
        return null;
    }
}

/**
 * Exact-match allowlist: http(s)://localhost, 127.0.0.1, [::1] (any port) and
 * app:// (Electron standard scheme). `null`, file:// and lookalikes are refused.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    const u = parseOrigin(origin);
    if (!u) return false;

    if (u.protocol === "http:" || u.protocol === "https:") {
        // u.origin drops userinfo/path/query, so any extra component makes this fail.
        return u.origin === origin && LOOPBACK_HOSTNAMES.has(u.hostname);
    }

    if (u.protocol === "app:") {
        return !u.username && !u.password && u.host.length > 0
            && (u.pathname === "" || u.pathname === "/") && !u.search && !u.hash
            && origin === `app://${u.host}`;
    }

    return false;
}

/**
 * Origin host[:port] equals the Host header (scheme ignored: TLS may be
 * terminated by a proxy). Lets a public deployment's own GraphiQL page call /mcp.
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
    if (!origin || !hostHeader) return false;
    const u = parseOrigin(origin);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return false;
    if (u.origin !== origin.toLowerCase()) return false;
    return u.host === hostHeader.toLowerCase();
}

/** Host header names a loopback host (DNS-rebinding protection). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
    return !!host && LOOPBACK_HOST_HEADER.test(host);
}

export type GuardDecision = {
    allowOrigin: string | null;
    reject: null | { status: 403; reason: string };
};

export function evaluateRequest({ method, origin, hostHeader, bindHost }: {
    method: string | undefined;
    origin: string | undefined;
    hostHeader: string | undefined;
    bindHost: string;
}): GuardDecision {
    const m = (method || "GET").toUpperCase();

    if (isLoopbackBind(bindHost) && !isLoopbackHostHeader(hostHeader)) {
        return { allowOrigin: null, reject: { status: 403, reason: "Host not allowed" } };
    }

    // No Origin: non-browser client (CLI, curl, mcp-remote, Node fetch bridge).
    if (origin === undefined) {
        return { allowOrigin: null, reject: null };
    }

    if (isAllowedOrigin(origin) || isSameOrigin(origin, hostHeader)) {
        return { allowOrigin: origin, reject: null };
    }

    if (m === "GET" || m === "HEAD") {
        return { allowOrigin: null, reject: null };
    }

    return { allowOrigin: null, reject: { status: 403, reason: "Origin not allowed" } };
}
