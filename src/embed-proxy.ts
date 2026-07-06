/**
 * Embedding service proxy — translates embed API to Ollama BGE-M3.
 * Replaces the old standalone BGE-M3 HTTP wrapper on port 8100.
 * Data-Oracle scripts expect: POST /embed {texts, return_sparse} → {dense, sparse}
 */

const PORT = Number(process.env.EMBED_PORT || "8100");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL || "bge-m3";

function l2Normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}

async function embedOne(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
  const data = await resp.json();
  return l2Normalize(data.embedding);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      try {
        const check = await fetch(`${OLLAMA_URL}/api/tags`);
        return Response.json({ status: "ok", model: MODEL, ollama: check.ok });
      } catch {
        return Response.json({ status: "degraded", error: "ollama unreachable" }, { status: 503 });
      }
    }

    if (url.pathname === "/embed" && req.method === "POST") {
      const body = await req.json();
      const texts: string[] = body.texts || [];
      if (!texts.length) {
        return Response.json({ error: "texts array required" }, { status: 400 });
      }

      const dense = await Promise.all(texts.map(embedOne));

      return Response.json({
        dense,
        sparse: [],
        model: MODEL,
        count: dense.length,
      });
    }

    return Response.json({ service: "embed-proxy", port: PORT, endpoints: ["/health", "/embed"] });
  },
});

console.log(`🔢 Embed proxy on :${PORT} (Ollama ${MODEL} at ${OLLAMA_URL})`);
