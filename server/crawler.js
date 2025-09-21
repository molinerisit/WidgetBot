import dotenv from "dotenv";
import cheerio from "cheerio";
import { request } from "undici";
import { getDB } from "./db.js";
import { embed } from "./openai.js";
dotenv.config();

const BOT_ID = process.argv.find(a=>a.startsWith("--bot="))?.split("=")[1] || "cibergaucho-bot";
const START_URL = process.argv.find(a=>a.startsWith("--url="))?.split("=")[1];
const CHUNK = parseInt(process.argv.find(a=>a.startsWith("--chunk="))?.split("=")[1]||"200",10);
const OVERLAP = parseInt(process.argv.find(a=>a.startsWith("--overlap="))?.split("=")[1]||"40",10);

if (!START_URL) {
  console.error("Uso: node crawler.js --url=https://example.com --bot=cibergaucho-bot");
  process.exit(1);
}

async function fetchText(url){
  const { body } = await request(url);
  const html = await body.text();
  const $ = cheerio.load(html);
  ["script","style","noscript","nav","footer"].forEach(sel=>$(sel).remove());
  const title = $("title").first().text().trim();
  const text = $("body").text().replace(/\s+/g," ").trim();
  return { title, text };
}

function chunkText(text, size=200, overlap=40){
  const words = text.split(" ");
  const chunks = [];
  for (let i=0;i<words.length;i+= (size-overlap)){
    const part = words.slice(i, i+size).join(" ");
    if (part.trim().length>0) chunks.push(part.trim());
  }
  return chunks;
}

async function main(){
  const db = getDB();
  const { title, text } = await fetchText(START_URL);
  const info = db.prepare("INSERT INTO documents(bot_id,source,uri,title,lang,type,updated_at) VALUES (?,?,?,?,?,?,?)")
                 .run(BOT_ID, "web", START_URL, title||null, "es", "page", Date.now());
  const docId = info.lastInsertRowid;
  const parts = chunkText(text, CHUNK, OVERLAP);
  let seq = 0;
  const insChunk = db.prepare("INSERT INTO chunks(document_id, seq, content, uri, metadata) VALUES (?,?,?,?,?)");
  const insEmb = db.prepare("INSERT INTO embeddings(chunk_id, vector) VALUES (?,?)");
  for (const p of parts){
    const r = insChunk.run(docId, seq++, p, START_URL, "{}");
    const cid = r.lastInsertRowid;
    const v = await embed(p);
    insEmb.run(cid, JSON.stringify(v));
  }
  db.close();
  console.log(`Crawled ${START_URL} -> ${parts.length} chunks`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
