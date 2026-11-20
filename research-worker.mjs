const events = "https://api.gemini.com/v1/prediction-markets/events";

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=30" : "no-store",
    ...extra
  } });
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return json({ error: "Use GET" }, 405, { Allow: "GET" });
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/") return json({ name: "Verity Research API", version: 1,
      endpoints: ["/v1/markets", "/v1/markets/{eventTicker}"], source: "Gemini Exchange" });
    const match = /^\/v1\/markets(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/.exec(pathname);
    if (!match) return json({ error: "Endpoint not found" }, 404);
    const source = new URL(match[1] ? events + "/" + match[1] : events);
    if (!match[1]) {
      const limit = Number(searchParams.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "limit must be 1–100" }, 400);
      source.searchParams.set("limit", String(limit));
    }
    try {
      const response = await fetch(source, { headers: { Accept: "application/json" }, redirect: "error",
        signal: AbortSignal.timeout(10000), cf: { cacheTtlByStatus: { "200-299": 30, "400-599": 0 } } });
      if (response.status === 404) return json({ error: "Market not found", source: source.href }, 404);
      if (!response.ok) return json({ error: "Market source unavailable", source: source.href }, 502);
      return json({ source: source.href, data: await response.json() });
    } catch {
      return json({ error: "Market source unavailable", source: source.href }, 502);
    }
  }
};
