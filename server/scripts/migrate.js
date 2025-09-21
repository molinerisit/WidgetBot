import fs from "fs";
import path from "path";
import { getDB } from "../db.js";

async function main(){
  const db = getDB();
  const sql = fs.readFileSync(path.resolve(process.cwd(),"scripts/schema.sql"),"utf-8");
  db.exec(sql);
  const botId = "cibergaucho-bot";
  const exists = db.prepare("SELECT 1 FROM bots WHERE id=?").get(botId);
  if (!exists){
    db.prepare("INSERT INTO bots(id,name,mode,focus) VALUES (?,?,?,?)")
      .run(botId, "Cibergaucho Bot", "ventas", "Guía de ventas y atención al cliente");
  }
  db.close();
  console.log("Migration ok (SQLite).");
}
main().catch(e=>{ console.error(e); process.exit(1); });
