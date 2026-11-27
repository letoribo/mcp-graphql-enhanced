/**
 * Scope operator credentials (env.HEADERS) to operator-configured endpoints.
 * Per-call endpoint overrides never receive env.HEADERS.
 */

/**
 * Normalize a URL to origin + path for endpoint comparison.
 * Lowercases scheme/host, drops default ports, userinfo, query and hash,
 * and treats trailing-slash variants as the same path.
 * Returns null for anything that is not a parseable http(s) URL.
 */
export function normalizeEndpointUrl(raw: string | undefined | null): string | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Split a comma-separated endpoint list (env.ENDPOINT format).
 */
export function parseEndpointList(value: string | undefined | null): string[] {
    if (!value) return [];
    return value.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * True when targetUrl points at one of the configured endpoints.
 */
export function isConfiguredEndpoint(targetUrl: string, configured: readonly string[]): boolean {
    const target = normalizeEndpointUrl(targetUrl);
    if (!target) return false;
    return configured.some(entry => normalizeEndpointUrl(entry) === target);
}

/**
 * Drop body-only headers so a POST's header set can be reused for a GET.
 */
export function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([k]) => !["content-type", "content-length"].includes(k.toLowerCase()))
    );
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() for requests that may carry operator headers. Redirects are followed
 * manually and only while the next Location is still a trusted endpoint; any other
 * redirect is returned as-is (not followed), so the headers never reach that URL.
 */
export async function fetchFollowingTrustedRedirects(
    url: string,
    init: RequestInit,
    trusted: readonly string[],
    maxRedirects: number = 5
): Promise<Response> {
    let current = url;
    let opts: RequestInit = { ...init, redirect: "manual" };
    for (let hop = 0; ; hop++) {
        const res = await fetch(current, opts);
        if (!REDIRECT_STATUSES.has(res.status)) return res;
        const location = res.headers.get("location");
        if (!location || hop >= maxRedirects) return res;
        let next: string;
        try {
            next = new URL(location, current).toString();
        } catch {
            return res;
        }
        if (!isConfiguredEndpoint(next, trusted)) return res;
        await res.body?.cancel();
        const method = (opts.method ?? "GET").toUpperCase();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
            const headers = withoutBodyHeaders((opts.headers ?? {}) as Record<string, string>);
            opts = { ...opts, method: "GET", body: undefined, headers };
        }
        current = next;
    }
}

/**
 * Headers to send to targetUrl: operator headers only if the target is configured,
 * per-call headers always (the caller chose both the URL and those headers).
 */
export function selectOutboundHeaders(
    targetUrl: string,
    configured: readonly string[],
    operatorHeaders: Record<string, string> | undefined,
    runtimeHeaders?: Record<string, string>
): Record<string, string> {
    const trusted = isConfiguredEndpoint(targetUrl, configured);
    return {
        ...(trusted ? (operatorHeaders ?? {}) : {}),
        ...(runtimeHeaders ?? {}),
    };
}
