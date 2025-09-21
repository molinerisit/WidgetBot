import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import { request } from "undici";
import { getDB } from "./db.js";
import { retrieve } from "./rag.js";
import { chat } from "./openai.js";
dotenv.config();

const PORT = process.env.PORT || 8787;
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

app.use("/", express.static(path.resolve(process.cwd(), "../public")));
app.use("/embed", express.static(path.resolve(process.cwd(), "../widget")));

const DATA_FILE = path.resolve(process.cwd(), "storage.json");
function load() { try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf-8")); } catch{ return { config:{}, conversations:{}, messages:{} }; } }
function save(mem){ fs.writeFileSync(DATA_FILE, JSON.stringify(mem,null,2)); }
let mem = load();

if (!mem.config || Object.keys(mem.config).length===0){
  const seed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),"seed-config.json"),"utf-8"));
  mem.config = seed; save(mem);
}

function ensureApprovalsTable(db){
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT,
    tool_name TEXT,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    requested_by TEXT,
    reviewed_by TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );`);
}

const ENV_PATH = path.resolve(process.cwd(), ".env");
function upsertEnv(vars){
  let text=""; try{ text=fs.readFileSync(ENV_PATH,"utf-8"); }catch{}
  const lines = text.split(/\r?\n/).filter(Boolean);
  const map = new Map(lines.map(l=>{ const i=l.indexOf("="); return i===-1?[l,""]:[l.slice(0,i),l.slice(i+1)]; }));
  for (const [k,v] of Object.entries(vars)){ if (typeof v === "string") map.set(k, v.replace(/\r?\n/g,"")); }
  const out = Array.from(map.entries()).map(([k,v])=>`${k}=${v}`).join(os.EOL)+os.EOL;
  fs.writeFileSync(ENV_PATH,out,"utf-8");
}

// Admin APIs
app.get("/admin/config", (_,res)=> res.json(mem.config||{}));
app.post("/admin/config", (req,res)=>{ mem.config=req.body; save(mem); res.json({ok:true}); });

// Rules upload/export
app.post("/admin/rules/upload", (req,res)=>{
  const { text, format } = req.body||{};
  if (!text) return res.status(400).json({ok:false,error:"Falta 'text'"});
  let rules=[];
  try{
    if ((format||"").toLowerCase()==="json" || text.trim().startsWith("[")){
      const arr = JSON.parse(text); if (!Array.isArray(arr)) throw new Error("JSON debe ser array");
      rules = arr.map(x=>String(x)).filter(Boolean);
    } else {
      const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      for (const ln of lines){ if (/^rule[,;]?$/i.test(ln)) continue; const cell = ln.split(/[,;\t]/)[0]; if (cell) rules.push(cell); }
    }
  }catch(e){ return res.status(400).json({ok:false,error:"No se pudo parsear: "+e.message}); }
  mem.config.rules = Array.from(new Set([...(mem.config.rules||[]), ...rules]));
  save(mem); res.json({ok:true, added: rules.length, total: mem.config.rules.length});
});
app.get("/admin/rules/export", (req,res)=> res.json({ rules: mem.config.rules||[] }));

// Secrets (.env local)
app.post("/admin/secrets", (req,res)=>{
  const { externalApiUrl, externalDbUrl } = req.body||{};
  try{ upsertEnv({ EXTERNAL_API_URL: externalApiUrl||"", EXTERNAL_DB_URL: externalDbUrl||"" }); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false, error:e.message}); }
});
app.post("/admin/test-connector", async (req,res)=>{
  const { url } = req.body||{};
  if (!url) return res.status(400).json({ok:false,error:"Falta url"});
  try{ const { statusCode } = await request(url, { method:"GET" }); res.json({ ok: statusCode>=200&&statusCode<400, statusCode }); }
  catch(e){ res.json({ ok:false, error:e.message }); }
});

// Conversations & Messages
app.post("/v1/conversations", (req,res)=>{
  const id = nanoid();
  mem.conversations[id] = { id, bot_id: req.body?.bot_id || mem.config.bot.id, started_at: Date.now(), user: req.body?.user || { id:"anon" } };
  mem.messages[id] = []; save(mem); res.json(mem.conversations[id]);
});

function matchFaq(text){ const t=(text||"").toLowerCase(); for (const f of (mem.config.faq||[])){ if (t.includes((f.q||"").toLowerCase().slice(0,12))) return f.a; } return null; }
function maybeHandoff(text){
  const wants=/humano|agente|asesor|whatsapp|correo|email/i.test(text||"");
  if(!wants||!mem.config.handoff?.enabled) return null;
  const h=mem.config.handoff;
  if (h.method==="whatsapp" && h.whatsappNumber){ return `Te derivo con un asesor humano por WhatsApp: https://wa.me/${h.whatsappNumber.replace(/[^0-9]/g,'')}`; }
  if (h.method==="email" && h.emailAddress){ return `Te derivo con un asesor humano por email: ${h.emailAddress}`; }
  return `Puedo derivarte a un agente humano. ¿Preferís WhatsApp o correo?`;
}

app.post("/v1/messages", async (req,res)=>{
  const { conversation_id, text } = req.body||{};
  if (!conversation_id || !mem.messages[conversation_id]) return res.status(400).json({error:"conversation_id inválido"});
  mem.messages[conversation_id].push({ role:"user", content:text, ts:Date.now() });

  const h = maybeHandoff(text);
  if (h){ const m={ role:"assistant", content:h, ts:Date.now(), meta:{handoff:true} }; mem.messages[conversation_id].push(m); save(mem); return res.json(m); }

  const faqAns = matchFaq(text);
  if (faqAns){ const m={ role:"assistant", content:faqAns, ts:Date.now(), meta:{source:"faq"} }; mem.messages[conversation_id].push(m); save(mem); return res.json(m); }

  const k = mem.config?.rag?.topK || 6;
  const ctx = await retrieve({ text, topK:k, botId: mem.config?.bot?.id || "cibergaucho-bot" });

  const sys = `Eres el asistente de ${mem.config.bot.name}. Objetivo: ${mem.config.bot.focus}.
Responde solo con los hechos del contexto. Si falta info, pregunta de forma amable.
Respeta reglas de negocio: ${(mem.config.rules||[]).slice(0,6).join(" | ")}`;

  const showSources = mem.config?.ui?.showSources !== false;
  const citations = ctx.map(c=>`- ${c.uri}`).join("\n");
  const ctxText   = ctx.map(c=>`[${c.uri}] ${c.content}`).join("\n---\n");

  let content;
  try{
    const message = await chat({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: parseFloat(process.env.OPENAI_TEMPERATURE||"0.3"),
      messages:[ {role:"system", content:sys}, {role:"user", content:`Pregunta: ${text}\n\nContexto:\n${ctxText}${showSources? "\n\nIncluye una línea de \"Fuentes (fragmentos usados)\" si corresponde.":""}`} ] });
    const block = (showSources && citations.trim()) ? `\n\nFuentes (fragmentos usados):\n${citations}` : "";
    content = `${message.content}${block}`;
  }catch(e){
    content = `(Falló llamada al modelo) Resumen del contexto para "${text}":\n` + ctx.map(c=>"- "+c.content.slice(0,160)).join("\n");
  }
  const m = { role:"assistant", content, ts:Date.now(), meta:{source:"rag+llm"} };
  mem.messages[conversation_id].push(m); save(mem); res.json(m);
});

app.post("/v1/index/web", async (req,res)=>{
  const { url } = req.body||{};
  try{ const { exec } = await import("child_process"); const child = exec(`node crawler.js --url=${url} --bot=${mem.config.bot.id}`); child.on("exit", c=>console.log("crawler exit",c)); res.json({ok:true,enqueued:true,url}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post("/v1/tools/:name/request", (req,res)=>{
  const db=getDB(); ensureApprovalsTable(db);
  const r = db.prepare("INSERT INTO approvals(bot_id, tool_name, payload, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(mem.config.bot.id, req.params.name, JSON.stringify(req.body||{}), "pending", Date.now(), Date.now());
  db.close(); res.json({ ok:true, approval:{ id:r.lastInsertRowid, status:"pending" } });
});
app.get("/admin/approvals", (req,res)=>{ const db=getDB(); ensureApprovalsTable(db); const rows=db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all(); db.close(); res.json(rows); });
app.post("/admin/approvals/:id/approve",(req,res)=>{ const db=getDB(); ensureApprovalsTable(db); db.prepare("UPDATE approvals SET status='approved', updated_at=? WHERE id=?").run(Date.now(), req.params.id); db.close(); res.json({ok:true}); });
app.post("/admin/approvals/:id/reject",(req,res)=>{ const db=getDB(); ensureApprovalsTable(db); db.prepare("UPDATE approvals SET status='rejected', updated_at=? WHERE id=?").run(Date.now(), req.params.id); db.close(); res.json({ok:true}); });

// ================= EXPLORAR DATOS (SQLite + Conector externo) =================
function toInt(v, def){ v = parseInt(v,10); return Number.isFinite(v) && v>=0 ? v : def; }
function likeEsc(s){ return String(s||"").replace(/[%_]/g, m => "\\"+m).slice(0,200); }
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;

// Resumen de tablas y config
app.get("/admin/db/summary", (req, res) => {
  const db = getDB();
  const tables = {
    bots: db.prepare("SELECT COUNT(*) AS c FROM bots").get().c,
    documents: db.prepare("SELECT COUNT(*) AS c FROM documents").get().c,
    chunks: db.prepare("SELECT COUNT(*) AS c FROM chunks").get().c,
    embeddings: db.prepare("SELECT COUNT(*) AS c FROM embeddings").get().c,
  };
  db.close();
  res.json({
    tables,
    config: {
      bot: mem.config?.bot || null,
      faq: (mem.config?.faq || []).length,
      rules: (mem.config?.rules || []).length,
      rag: mem.config?.rag || null,
      handoff: mem.config?.handoff || null,
      ui: mem.config?.ui || null,
    }
  });
});

// Bots
app.get("/admin/db/bots", (req,res)=>{
  const db = getDB();
  const rows = db.prepare("SELECT id,name,mode,focus FROM bots ORDER BY id").all();
  db.close(); res.json({rows});
});

// Documentos (con búsqueda por URI/título)
app.get("/admin/db/documents", (req,res)=>{
  const limit  = Math.min(toInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const offset = toInt(req.query.offset, 0);
  const botId  = (req.query.bot_id || mem.config?.bot?.id || "").trim();
  const search = (req.query.search || "").trim();

  const db = getDB();
  let rows;
  if (search) {
    const s = `%${likeEsc(search)}%`;
    rows = db.prepare(`
      SELECT id, bot_id, source, uri, title, type, lang, updated_at
      FROM documents
      WHERE bot_id = ? AND (uri LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT ? OFFSET ?
    `).all(botId, s, s, limit, offset);
  } else {
    rows = db.prepare(`
      SELECT id, bot_id, source, uri, title, type, lang, updated_at
      FROM documents
      WHERE bot_id = ?
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT ? OFFSET ?
    `).all(botId, limit, offset);
  }
  db.close();
  res.json({rows, limit, offset});
});

// Chunks por documento (con preview)
app.get("/admin/db/chunks", (req,res)=>{
  const limit  = Math.min(toInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const offset = toInt(req.query.offset, 0);
  const docId  = toInt(req.query.document_id, 0);
  if (!docId) return res.status(400).json({error:"Falta document_id"});

  const db = getDB();
  const rows = db.prepare(`
    SELECT id, seq, substr(content,1,300) AS preview, uri
    FROM chunks
    WHERE document_id = ?
    ORDER BY seq ASC
    LIMIT ? OFFSET ?
  `).all(docId, limit, offset);
  db.close();
  res.json({rows, limit, offset});
});

// FAQ / Reglas / Mensajes (solo lectura)
app.get("/admin/db/faq", (req,res)=> res.json({faq: mem.config?.faq || []}));
app.get("/admin/db/rules", (req,res)=> res.json({rules: mem.config?.rules || []}));
app.get("/admin/db/messages", (req,res)=>{
  const cid = (req.query.conversation_id || "").trim();
  if (!cid || !mem.messages[cid]) return res.json({rows: []});
  const limit  = Math.min(toInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const offset = toInt(req.query.offset, 0);
  const rows = (mem.messages[cid] || []).slice(offset, offset + limit);
  res.json({rows, limit, offset, total: (mem.messages[cid] || []).length});
});

// Conector externo (GET read-only)
function getExternalBase(){
  return (process.env.EXTERNAL_API_URL || "").replace(/\/+$/,"");
}
app.get("/admin/connector/ping", async (req,res)=>{
  const base = getExternalBase();
  if (!base) return res.json({ok:false, error:"EXTERNAL_API_URL no configurada"});
  try {
    const { statusCode } = await request(base, { method: "GET" });
    res.json({ ok: statusCode>=200 && statusCode<400, statusCode, base });
  } catch (e) {
    res.json({ ok:false, error: e.message, base });
  }
});

// GET a un path permitido (whitelist) p.ej. /productos, /stock, /reservas
app.get("/admin/connector/get", async (req,res)=>{
  const base = getExternalBase();
  const rawPath = String(req.query.path || "").trim();
  if (!base) return res.status(400).json({error:"EXTERNAL_API_URL no configurada"});
  if (!rawPath || !rawPath.startsWith("/")) return res.status(400).json({error:"path inválido (use /recurso)"});
  const ALLOWED = ["/productos", "/stock", "/reservas", "/health", "/status"];
  if (!ALLOWED.includes(rawPath)) {
    const p = rawPath.split("?")[0];
    if (!ALLOWED.includes(p)) return res.status(403).json({error:"path no permitido"});
  }
  const url = base + rawPath;
  try {
    const r = await request(url, { method: "GET" });
    const text = await r.body.text();
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json) && json.length > 200) {
        return res.json({ ok:true, status: r.statusCode, count: json.length, sample: json.slice(0,50) });
      }
      return res.json({ ok:true, status: r.statusCode, data: json });
    } catch {
      return res.json({ ok:true, status: r.statusCode, text: text.slice(0,5000) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ================= FIN EXPLORAR DATOS =================

app.get("/healthz", (_,res)=>res.json({ok:true}));

app.listen(PORT, ()=>{
  console.log("RAG Bot (SQLite) v0.4.1 on http://localhost:"+PORT);
  console.log("Admin:   http://localhost:%s/admin.html", PORT);
  console.log("Demo:    http://localhost:%s/", PORT);
});
