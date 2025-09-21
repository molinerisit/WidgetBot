# RAG Bot Starter — SQLite + Admin UI (v0.4.1)

## Run
cd server
cp .env.example .env
npm install
npm run migrate
npm start

Admin: http://localhost:8787/admin.html
Demo:  http://localhost:8787/

Features: Admin UI (modo, reglas con upload/export, FAQ, handoff, conectores), SQLite FTS5 + embeddings JSON cosine re-rank, crawler, OpenAI opcional.
