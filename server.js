import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { PORT = 3000, PIN = '1234', LLM_URL = 'http://localhost:11434/v1', LLM_KEY = '', LLM_MODEL = 'hermes3' } = process.env;
const db = new DatabaseSync(process.env.DB_PATH || 'contacts.db');
db.exec(`CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, met_by TEXT, fields TEXT DEFAULT '{}', messages TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

const SYSTEM = `You are a fast assistant helping a senior executive of a services company log a person they just met at an event.
Extract: name, company, role, what_they_do, needs (what they might need from us), meet_again (yes/no/maybe), notes.
Ask ONE short follow-up question at a time about the most important missing field (always ask meet_again before finishing). Never ask more than one question.
When name, company, what_they_do and meet_again are known, say a brief "Saved. Next person?" and set done=true.
Reply ONLY with JSON: {"reply":"...","fields":{...only fields learned so far...},"done":false}`;

async function ask(messages) {
  const r = await fetch(`${LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, ...messages] }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
  const text = (await r.json()).choices[0].message.content;
  try { return JSON.parse(text.replace(/^```(?:json)?|```$/gm, '').trim()); }
  catch { return { reply: text, fields: {}, done: false }; }
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      if (req.headers['x-pin'] !== PIN) return json(res, 401, { error: 'bad pin' });
      if (req.url === '/api/contacts') {
        return json(res, 200, db.prepare('SELECT id, met_by, fields, created_at FROM contacts ORDER BY id DESC').all().map((c) => ({ ...c, fields: JSON.parse(c.fields) })));
      }
      if (req.url === '/api/chat' && req.method === 'POST') {
        const { id, met_by, message } = await body(req);
        let row = id && db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
        if (!row) row = db.prepare('INSERT INTO contacts (met_by) VALUES (?) RETURNING *').get(met_by);
        const msgs = [...JSON.parse(row.messages), { role: 'user', content: message }];
        const out = await ask(msgs);
        msgs.push({ role: 'assistant', content: JSON.stringify(out) });
        const fields = { ...JSON.parse(row.fields), ...out.fields };
        db.prepare("UPDATE contacts SET fields=?, messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(fields), JSON.stringify(msgs), row.id);
        return json(res, 200, { id: row.id, reply: out.reply, fields, done: !!out.done });
      }
      return json(res, 404, {});
    }
    const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const path = `public${file}`;
    if (file.includes('..') || !fs.existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(fs.readFileSync(path));
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}`));
