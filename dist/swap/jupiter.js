export const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
export const JUPITER_TIMEOUT_MS = 10_000;
export async function jupiterFetch(path, init = {}) {
    const res = await fetch(`${JUPITER_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`Jupiter ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
}
//# sourceMappingURL=jupiter.js.map