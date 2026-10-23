import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const MAX_CHUNKS = 50; // 50 x 4 MB = 200 MB per file
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  const passcode = Netlify.env.get("VAULT_PASSCODE");
  if (!passcode) {
    return json({ error: "VAULT_PASSCODE is not set. Add it in Netlify environment variables, then redeploy." }, 500);
  }
  if (req.headers.get("x-passcode") !== passcode) {
    return json({ error: "Wrong passcode." }, 401);
  }

  const store = getStore("ferry");
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  if (parts[0] !== "files") return json({ error: "Not found." }, 404);

  const [, id, sub, n] = parts;

  // GET /api/files
  if (!id && method === "GET") {
    const { blobs } = await store.list({ prefix: "meta/" });
    const metas = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    const files = metas.filter((m) => m && m.complete).sort((a, b) => b.created - a.created);
    return json({ files });
  }

  // POST /api/files  { name, size, chunks }
  if (!id && method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
    const name = String(body.name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200);
    const size = Number(body.size);
    const chunks = Number(body.chunks);
    if (!name || !Number.isFinite(size) || size < 0 || !Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) {
      return json({ error: "File is empty or larger than 200 MB." }, 400);
    }
    const newId = crypto.randomUUID();
    await store.setJSON(`meta/${newId}`, { id: newId, name, size, chunks, created: Date.now(), complete: false });
    return json({ id: newId });
  }

  const meta = id ? await store.get(`meta/${id}`, { type: "json" }) : null;
  if (!meta) return json({ error: "File not found." }, 404);

  // PUT /api/files/:id/chunks/:n
  if (sub === "chunks" && method === "PUT") {
    const i = Number(n);
    if (!Number.isInteger(i) || i < 0 || i >= meta.chunks) return json({ error: "Bad chunk." }, 400);
    await store.set(`chunk/${id}/${i}`, await req.arrayBuffer());
    return json({ ok: true });
  }

  // GET /api/files/:id/chunks/:n
  if (sub === "chunks" && method === "GET") {
    const i = Number(n);
    if (!Number.isInteger(i) || i < 0 || i >= meta.chunks) return json({ error: "Bad chunk." }, 400);
    const data = await store.get(`chunk/${id}/${i}`, { type: "arrayBuffer" });
    if (!data) return json({ error: "Chunk missing." }, 404);
    return new Response(data, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }

  // POST /api/files/:id/complete
  if (sub === "complete" && method === "POST") {
    const { blobs } = await store.list({ prefix: `chunk/${id}/` });
    if (blobs.length !== meta.chunks) return json({ error: "Upload incomplete. Try again." }, 409);
    await store.setJSON(`meta/${id}`, { ...meta, complete: true });
    return json({ ok: true });
  }

  // DELETE /api/files/:id
  if (!sub && method === "DELETE") {
    const { blobs } = await store.list({ prefix: `chunk/${id}/` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    await store.delete(`meta/${id}`);
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
};
