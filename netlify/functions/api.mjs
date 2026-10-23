import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const MAX_CHUNKS = 50; // 50 x 4 MB = 200 MB per file
const AGENT_ONLINE_MS = 15000;

const PAPERS = ["A4", "A3", "A5", "Letter", "Legal"];
const PAPER_TYPES = ["plain", "photo", "glossy", "card"];
const COLORS = ["color", "mono"];
const SIDES = ["single", "duplex_long", "duplex_short"];
const STATUSES = ["queued", "printing", "done", "failed"];

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
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const [root, id, sub, n] = parts;

  const readBody = async () => { try { return await req.json(); } catch { return null; } };

  /* ---------- agent ---------- */
  if (root === "agent" && id === "ping" && method === "POST") {
    const b = (await readBody()) || {};
    await store.setJSON("agent/last", {
      name: String(b.name || "Print computer").slice(0, 60),
      printer: String(b.printer || "Default printer").slice(0, 80),
      seen: Date.now(),
    });
    return json({ ok: true });
  }

  /* ---------- print jobs ---------- */
  if (root === "jobs") {
    // GET /api/jobs
    if (!id && method === "GET") {
      const { blobs } = await store.list({ prefix: "job/" });
      const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
      const jobs = all.filter(Boolean).sort((a, b) => b.created - a.created).slice(0, 40);
      const last = await store.get("agent/last", { type: "json" });
      const agent = last
        ? { online: Date.now() - last.seen < AGENT_ONLINE_MS, name: last.name, printer: last.printer, seen: last.seen }
        : { online: false };
      return json({ jobs, agent });
    }

    // POST /api/jobs
    if (!id && method === "POST") {
      const b = await readBody();
      if (!b) return json({ error: "Bad request." }, 400);
      const meta = await store.get(`meta/${String(b.fileId)}`, { type: "json" });
      if (!meta || !meta.complete) return json({ error: "File not found." }, 404);
      const copies = Number(b.copies);
      const pages = String(b.pages || "").replace(/\s+/g, "");
      if (!Number.isInteger(copies) || copies < 1 || copies > 99) return json({ error: "Copies must be 1 to 99." }, 400);
      if (!PAPERS.includes(b.paper) || !PAPER_TYPES.includes(b.paperType) || !COLORS.includes(b.color) || !SIDES.includes(b.sides)) {
        return json({ error: "Invalid print options." }, 400);
      }
      if (pages && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(pages)) return json({ error: "Page range looks wrong. Use 1-3,5." }, 400);
      const jobId = crypto.randomUUID();
      const job = {
        id: jobId, fileId: meta.id, fileName: meta.name, copies, paper: b.paper, paperType: b.paperType,
        color: b.color, sides: b.sides, pages, status: "queued", message: "", created: Date.now(), updated: Date.now(),
      };
      await store.setJSON(`job/${jobId}`, job);
      return json({ job });
    }

    // DELETE /api/jobs  (clear finished)
    if (!id && method === "DELETE") {
      const { blobs } = await store.list({ prefix: "job/" });
      for (const bl of blobs) {
        const j = await store.get(bl.key, { type: "json" });
        if (j && (j.status === "done" || j.status === "failed")) await store.delete(bl.key);
      }
      return json({ ok: true });
    }

    const job = id ? await store.get(`job/${id}`, { type: "json" }) : null;
    if (!job) return json({ error: "Job not found." }, 404);

    // POST /api/jobs/:id/status
    if (sub === "status" && method === "POST") {
      const b = await readBody();
      if (!b || !STATUSES.includes(b.status)) return json({ error: "Bad status." }, 400);
      await store.setJSON(`job/${id}`, { ...job, status: b.status, message: String(b.message || "").slice(0, 300), updated: Date.now() });
      return json({ ok: true });
    }

    // DELETE /api/jobs/:id
    if (!sub && method === "DELETE") {
      await store.delete(`job/${id}`);
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  }

  /* ---------- files ---------- */
  if (root !== "files") return json({ error: "Not found." }, 404);

  // GET /api/files
  if (!id && method === "GET") {
    const { blobs } = await store.list({ prefix: "meta/" });
    const metas = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    const files = metas.filter((m) => m && m.complete).sort((a, b) => b.created - a.created);
    return json({ files });
  }

  // POST /api/files  { name, size, chunks }
  if (!id && method === "POST") {
    const body = await readBody();
    if (!body) return json({ error: "Bad request." }, 400);
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
