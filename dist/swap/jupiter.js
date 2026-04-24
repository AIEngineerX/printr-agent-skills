export const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
export const JUPITER_TIMEOUT_MS = 10_000;
/** Thrown when Jupiter's HTTP API returns a non-2xx response. Adopters can
 *  catch this specifically to distinguish upstream availability issues from
 *  local validation errors or on-chain failures. */
export class JupiterApiError extends Error {
    status;
    path;
    body;
    constructor(path, status, body) {
        super(`Jupiter ${path} failed: ${status} ${body}`);
        this.name = 'JupiterApiError';
        this.path = path;
        this.status = status;
        this.body = body;
    }
}
export async function jupiterFetch(path, init = {}) {
    const res = await fetch(`${JUPITER_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new JupiterApiError(path, res.status, await res.text());
    }
    return res;
}
//# sourceMappingURL=jupiter.js.map