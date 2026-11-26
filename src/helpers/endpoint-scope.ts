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
