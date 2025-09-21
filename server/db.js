import Database from "better-sqlite3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const DB_PATH = process.env.SQLITE_PATH || "./data/ragbot.db";

export function getDB(){
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}
