import { getDB } from "./db.js";
import { embed } from "./openai.js";

/** Coseno entre dos vectores */
function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na || 1) * Math.sqrt(nb || 1));
}

/** Convierte texto libre a una consulta segura para FTS5.
 *  - Solo palabras [letras/números/underscore]
 *  - Toma hasta 8 tokens
 *  - Usa búsqueda por prefijo: token*
 *  - Une con OR
 */
function makeFtsQuery(text) {
  const tokens = (text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) || [];
  const capped = tokens.slice(0, 8);
  if (!capped.length) return null;
  // Prefijo (no usar comillas porque rompen el *)
  const terms = capped.map(t => `${t}*`);
  return terms.join(" OR ");
}

export async function retrieve({ text, topK = 6, botId = "cibergaucho-bot" }) {
  const db = getDB();

  // 1) Recuperación inicial (FTS5 con query saneada)
  const ftsQuery = makeFtsQuery(text);
  let candidates = [];
  try {
    if (ftsQuery) {
      const stmt = db.prepare(`
        SELECT rowid AS id, content, uri
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT 30
      `);
      candidates = stmt.all(ftsQuery);
    }
  } catch (e) {
    // Si la consulta FTS falla por algún carácter extraño, seguimos con fallback
    candidates = [];
  }

  // 2) Fallback: LIKE si FTS no devolvió nada
  if (!candidates.length) {
    const like = `%${(text || "").slice(0, 64)}%`; // acotamos para índice y performance
    const stmt = db.prepare(`
      SELECT c.id AS id, c.content AS content, c.uri AS uri
      FROM chunks c
      WHERE c.content LIKE ?
      ORDER BY c.id DESC
      LIMIT 30
    `);
    candidates = stmt.all(like);
  }

  // 3) Re-rank con embeddings (coseno)
  const qvec = await embed(text || "");
  const rows = [];
  for (const c of candidates) {
    const e = db.prepare("SELECT vector FROM embeddings WHERE chunk_id=?").get(c.id);
    let score_vec = 0;
    if (e && e.vector) {
      try { score_vec = cosine(qvec, JSON.parse(e.vector)); } catch { score_vec = 0; }
    }
    rows.push({ id: c.id, content: c.content, uri: c.uri, score_vec });
  }

  // Normalizamos y mezclamos BM25/orden + coseno
  const maxv = Math.max(...rows.map(r => r.score_vec), 1e-6);
  for (const r of rows) r.score_vec = r.score_vec / maxv;

  const blended = rows
    .map((r, i) => ({
      ...r,
      score: 0.6 * (1 - i / Math.max(rows.length - 1, 1)) + 0.4 * r.score_vec,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  db.close();
  return blended;
}
