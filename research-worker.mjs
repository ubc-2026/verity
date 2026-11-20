const events = "https://api.gemini.com/v1/prediction-markets/events";

const brief = {
  ticker: "NBA-2611200100-LAC-SAS-T",
  title: "Los Angeles C vs San Antonio: Total Points",
  researchDate: "2026-11-20",
  instrumentSymbol: "GEMI-NBA-2611200100-LAC-SAS-T-O231",
  resolutionCriteria: "The over-231.5 contract resolves Yes if the two teams score at least 232 combined points. The rules specify an ordered list of sources for determining that total.",
  sourcePriority: ["NBA", "ESPN", "Fox Sports", "Official broadcast partner"],
  terms: "https://assets.gemini.com/predictions/terms_and_conditions/Terms_and_Conditions_NBA_Point_Total_Class_83dd60df-d1ae-434e-8083-776a0713244a.pdf",
  source: events + "/NBA-2611200100-LAC-SAS-T"
};

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
      endpoints: ["/v1/markets", "/v1/markets/{eventTicker}", "/v1/research"], source: "Gemini Exchange" });
    if (pathname === "/v1/research") return json({ data: [brief] });
    const match = /^\/v1\/markets(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/.exec(pathname);
    if (!match) return json({ error: "Endpoint not found" }, 404);
    const source = new URL(match[1] ? events + "/" + match[1] : events);
    if (!match[1]) {
      const limit = Number(searchParams.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "limit must be 1–100" }, 400);
      source.searchParams.set("limit", String(limit));
    }
    function unavailable() {
      if (match[1] && match[1] !== brief.ticker) return json({ error: "Market source unavailable", source: source.href }, 502);
      return json({ mode: "research_snapshot", live: false, source: source.href, data: match[1] ? brief : [brief] });
    }
    try {
      const response = await fetch(source.href, { headers: { Accept: "application/json" }, redirect: "error",
        cf: { cacheTtlByStatus: { "200-299": 30, "400-599": 0 } } });
      if (response.status === 404) return json({ error: "Market not found", source: source.href }, 404);
      if (!response.ok) return unavailable();
      return json({ mode: "live", live: true, source: source.href, data: await response.json() });
    } catch {
      return unavailable();
    }
  }
};
