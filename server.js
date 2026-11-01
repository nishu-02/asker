import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { PORT = 3000, PIN = '1234', LLM_URL = 'http://localhost:11434/v1', LLM_KEY = '', LLM_MODEL = 'hermes3', LLM_FALLBACK_MODEL = '', WORKSPACE_ID = '' } = process.env;
const FIELDS = ['name', 'company', 'role', 'contact_info', 'what_they_do', 'needs', 'timeline_budget', 'decision_maker', 'priority', 'meet_again', 'next_step', 'follow_up_owner', 'notes'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const PHOTOS = (process.env.DB_PATH || 'contacts.db').replace(/[^/]*$/, '') + 'photos';
const db = new DatabaseSync(process.env.DB_PATH || 'contacts.db');
db.exec(`CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, met_by TEXT, fields TEXT DEFAULT '{}', messages TEXT DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

fs.mkdirSync('/backups', { recursive: true });
setInterval(() => {
  const f = `/backups/contacts-${new Date().getHours()}.db`;
  try { fs.rmSync(f, { force: true }); db.exec(`VACUUM INTO '${f}'`); } catch (e) { console.error('backup failed', e.message); }
}, 5 * 60 * 1000);

const SYSTEM = `You are a sharp sales-intelligence assistant on the phone of a senior executive (CEO/CTO) of a services company, logging each person they meet at an event. Be brief, warm, fast.
Fields to fill (only include ones you actually learned): name, company, role, contact_info (phone/email/linkedin), what_they_do, needs (their problem, project or goal we could help with), timeline_budget, decision_maker (yes/no/unknown), meet_again (yes/no/maybe), next_step, follow_up_owner, priority (hot/warm/cold, your judgment), notes.
Each turn: absorb everything the user said (they may give many facts at once), then ask exactly ONE short, specific question, tied to what they just said, about the most valuable missing item, in this order:
1) who they are (name, company, role) 2) what they do and what they struggle with or want to build 3) urgency/timeline/budget and whether they decide 4) the close: propose a concrete next step ("Want to book a call this week? Who should follow up?") and how to reach them 5) meet_again.
Questions must help win business or capture useful intel; never generic ("anything else?"), never repeat a question, never ask what a photo or the user already told you. If the user doesn't know, say ok and move on.
Photos: a business card, a selfie, or any document. Read all text you can and fill fields; if unreadable, say so and ask for the name instead.
When you know name, company, what_they_do, next_step and meet_again (or the user says skip/done/next), reply with a one-line summary plus "Saved. Next person?" and set done=true.
Reply ONLY with JSON: {"reply":"...","fields":{...},"done":false}`;

async function ask(messages, image) {
  const models = [LLM_MODEL, ...LLM_FALLBACK_MODEL.split(',')].map((m) => m.trim().replace(/["'\s]|^models\//g, '')).filter(Boolean);
  let err;
  for (const model of models) {
    for (let i = 0; i < 2; i++) {
      try { return await call(model, messages, image); }
      catch (e) {
        err = e; console.error(`model ${model} failed: ${String(e.message).slice(0, 200)}`);
        if (![429, 500, 502, 503, 504].includes(e.status)) break;
        await new Promise((ok) => setTimeout(ok, 700 * (i + 1)));
      }
    }
  }
  throw err;
}

async function call(model, messages, image) {
  if (image) messages = [...messages.slice(0, -1), { role: 'user', content: [{ type: 'text', text: messages.at(-1).content }, { type: 'image_url', image_url: { url: image } }] }];
  const r = await fetch(`${LLM_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}`, ...(WORKSPACE_ID && { "anthropic-workspace-id": WORKSPACE_ID }) },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, ...messages] }),
  });
  if (!r.ok) throw Object.assign(new Error(`LLM ${r.status}: ${await r.text()}`), { status: r.status });
  const text = (await r.json()).choices[0].message.content;
  try { return JSON.parse(text.replace(/^```(?:json)?|```$/gm, '').trim()); }
  catch { return { reply: text, fields: {}, done: false }; }
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });

async function turn(id, met_by, message, image) {
  let row = id && db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
  if (!row) row = { messages: '[]', fields: '{}' };
  const msgs = [...JSON.parse(row.messages), { role: 'user', content: message }];
  const out = await ask(msgs, image).catch((e) => {
    if (!image) throw e;
    msgs.at(-1).content += ' (the image could not be read by the model)';
    return ask(msgs);
  });
  if (image) msgs.at(-1).content = '[photo attached] ' + message;
  msgs.push({ role: 'assistant', content: JSON.stringify(out) });
  const fields = { ...JSON.parse(row.fields), ...out.fields };
  if (!row.id) row.id = db.prepare('INSERT INTO contacts (met_by) VALUES (?) RETURNING id').get(met_by).id;
  db.prepare('UPDATE contacts SET fields=?, messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(fields), JSON.stringify(msgs), row.id);
  return { id: row.id, reply: out.reply, fields, done: !!out.done };
}

http.createServer(async (req, res) => {
  try {
    const photo = req.url.match(/^\/photo\/(\d+-\d+\.(\w+))\?pin=(.*)$/);
    if (photo) {
      const path = `${PHOTOS}/${photo[1]}`;
      if (decodeURIComponent(photo[3]) !== PIN || !fs.existsSync(path)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPE[photo[2]] || 'application/octet-stream' });
      return res.end(fs.readFileSync(path));
    }
    if (req.url.startsWith('/api/')) {
      if (req.headers['x-pin'] !== PIN) return json(res, 401, { error: 'bad pin' });
      if (req.url === '/api/contacts') {
        const files = fs.existsSync(PHOTOS) ? fs.readdirSync(PHOTOS) : [];
        return json(res, 200, db.prepare('SELECT id, met_by, fields, created_at FROM contacts ORDER BY id DESC').all().map((c) => ({ ...c, fields: JSON.parse(c.fields), photos: files.filter((f) => f.startsWith(`${c.id}-`)) })));
      }
      const edit = req.url.match(/^\/api\/contact\/(\d+)$/);
      if (edit && req.method === 'PUT') {
        const row = db.prepare('SELECT fields FROM contacts WHERE id=?').get(edit[1]);
        if (!row) return json(res, 404, { error: 'not found' });
        const { fields = {} } = await body(req);
        const merged = JSON.parse(row.fields);
        for (const k of FIELDS) { const v = String(fields[k] ?? '').trim().slice(0, 2000); if (v) merged[k] = v; else delete merged[k]; }
        db.prepare('UPDATE contacts SET fields=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(merged), edit[1]);
        return json(res, 200, { fields: merged });
      }
      if (req.url === '/api/chat' && req.method === 'POST') {
        const { id, met_by, message } = await body(req);
        return json(res, 200, await turn(id, met_by, message));
      }
      if (req.url === '/api/photo' && req.method === 'POST') {
        const { id: given, met_by, image } = await body(req);
        const m = /^data:([\w/+.-]+);base64,/.exec(image || '');
        if (!m) return json(res, 400, { error: 'bad file' });
        const id = given || db.prepare('INSERT INTO contacts (met_by) VALUES (?) RETURNING id').get(met_by).id;
        const name = `${id}-${Date.now()}.${EXT[m[1]] || 'bin'}`;
        const buf = Buffer.from(image.slice(m[0].length), 'base64');
        for (const dir of [PHOTOS, '/backups/photos']) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}`, buf); }
        const readable = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(m[1]);
        const text = readable ? 'I attached a photo (a business card, the person, or a document). Read what you can and continue.' : `I attached a file (${m[1]}) that you cannot open. Acknowledge it and continue.`;
        return json(res, 200, await turn(id, met_by, text, readable ? image : null));
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
