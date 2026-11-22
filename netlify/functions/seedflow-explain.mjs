export const config = {
  rateLimit: { action: "rate_limit", windowSize: 60, windowLimit: 6, aggregateBy: ["ip", "domain"] }
};

function reply(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export default async function explain(request) {
  if (request.method !== "POST") return reply(405, { error: "method" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return reply(415, { error: "content_type" });
  }
  const body = await request.text();
  if (body.length > 2048) return reply(413, { error: "size" });
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return reply(400, { error: "input" });
  }
  const { mode, targetKm, predictedKm, releaseMinutes, floodMinutes, timingPass, accepted } = data ?? {};
  if (!["DEMO", "ENGINEERING"].includes(mode)
      || ![targetKm, predictedKm, releaseMinutes, floodMinutes].every(v => Number.isFinite(v) && v >= 0)
      || typeof timingPass !== "boolean" || typeof accepted !== "boolean") {
    return reply(400, { error: "input" });
  }

  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return reply(503, { error: "configuration" });

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(14000),
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        store: false,
        max_output_tokens: 300,
        instructions: "اشرح النتائج الهندسية الواردة بالعربية في ثلاث نقاط موجزة. استخدم القيم كما هي. وضح توافق المسافة والتوقيت وحدود التحقق. في DEMO اذكر أنها بيانات تجريبية. لا تخترع قياسات ميدانية أو توصيات بإطلاق الكرات.",
        input: JSON.stringify({ mode, targetKm, predictedKm, releaseMinutes, floodMinutes, timingPass, accepted })
      })
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      console.warn("OpenAI request failed", upstream.status, upstream.headers.get("x-request-id"));
      if (upstream.status === 401 || upstream.status === 403) return reply(502, { error: "authentication" });
      if (result.error?.code === "insufficient_quota") return reply(503, { error: "quota" });
      if (upstream.status === 429) return reply(429, { error: "busy" });
      return reply(502, { error: "provider" });
    }
    const explanation = (result.output ?? [])
      .filter(item => item.type === "message" && item.role === "assistant")
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === "output_text")
      .map(part => part.text)
      .join("\n").trim();
    return explanation ? reply(200, { explanation }) : reply(502, { error: "empty" });
  } catch (error) {
    console.warn("OpenAI connection failed", error.name);
    return reply(502, { error: "provider" });
  }
}
