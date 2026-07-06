/**
 * BoBFace static server — serves dist-cf on port 3457
 * Proxies /api and /ws to maw-js backend on :3456
 */

const STATIC_DIR = `${import.meta.dir}/dist-cf`;
const BACKEND = "http://localhost:3456";
const PORT = 3457;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy API requests to maw-js backend
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      const target = `${BACKEND}${url.pathname}${url.search}`;
      return fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });
    }

    // Serve static assets (JS/CSS/images)
    if (url.pathname !== "/") {
      const file = Bun.file(`${STATIC_DIR}${url.pathname}`);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    // Root and SPA fallback — serve index.html with client-side /#bob force
    const html = await Bun.file(`${STATIC_DIR}/index.html`).text();
    const patched = html.replace(
      "<head>",
      `<head><script>if(!location.hash||location.hash==="#")location.replace("#bob");</script>`
    );
    return new Response(patched, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`BoBFace server running on http://localhost:${PORT}`);
