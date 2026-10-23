/**
 * Postgres Backup (versão online)
 *
 * Variáveis de ambiente:
 *   APP_PASSWORD    (obrigatória)  senha para entrar no sistema
 *   DATABASE_URL    connection string do banco (Neon). Pode definir também DB_QUALQUERNOME
 *                   para ter vários bancos na lista, ex.: DB_PRODUCAO, DB_TESTE
 *   SESSION_SECRET  texto aleatório longo para assinar o cookie de sessão
 *   PORT            porta (as plataformas definem sozinhas)
 *   PG_DUMP_PATH    caminho do pg_dump (o Dockerfile já define)
 *
 * Sem dependências npm. Node 18+.
 */

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const PG_DUMP = process.env.PG_DUMP_PATH || 'pg_dump';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_HOURS = 12;
const MAX_CONCURRENT_BACKUPS = 1;

if (!APP_PASSWORD) {
  console.error('ERRO: defina a variável de ambiente APP_PASSWORD (a senha de acesso ao sistema).');
  process.exit(1);
}
if (APP_PASSWORD.length < 10) {
  console.warn('AVISO: use uma APP_PASSWORD com pelo menos 10 caracteres.');
}

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('AVISO: SESSION_SECRET não definido. Um valor temporário foi gerado; você será deslogado a cada reinício.');
}

/* ------------------------------------------------------------------ */
/* Bancos configurados                                                 */
/* ------------------------------------------------------------------ */

function loadDatabases() {
  const dbs = {};
  if (process.env.DATABASE_URL) dbs['Principal'] = process.env.DATABASE_URL;
  for (const [k, v] of Object.entries(process.env)) {
    if (/^DB_[A-Z0-9_]+$/.test(k) && v) {
      const name = k.slice(3).toLowerCase().replace(/_/g, ' ');
      dbs[name.charAt(0).toUpperCase() + name.slice(1)] = v;
    }
  }
  return dbs;
}
const DATABASES = loadDatabases();

/* ------------------------------------------------------------------ */
/* Sessão e login                                                      */
/* ------------------------------------------------------------------ */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');

function passwordOk(input) {
  return crypto.timingSafeEqual(sha(input), sha(APP_PASSWORD));
}

function makeToken() {
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return exp + '.' + hmac(exp);
}

function tokenOk(token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  const good = hmac(exp);
  if (sig.length !== good.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isAuthed = (req) => tokenOk(getCookie(req, 'session'));

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

function sessionCookie(req, value, maxAgeSec) {
  return `session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` +
    (isHttps(req) ? '; Secure' : '');
}

// Limite de tentativas de login: 5 erros por IP => bloqueio de 15 minutos
const attempts = new Map();
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function blockedFor(ip) {
  const a = attempts.get(ip);
  if (a && a.until && a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 60000);
  if (a && a.until && a.until <= Date.now()) attempts.delete(ip);
  return 0;
}
function registerFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) { a.until = Date.now() + BLOCK_MS; a.count = 0; }
  attempts.set(ip, a);
}

/* ------------------------------------------------------------------ */
/* Páginas                                                             */
/* ------------------------------------------------------------------ */

const CSS = `
  :root {
    --bg: #eaf0f2; --panel: #ffffff; --ink: #13232c; --muted: #586b75; --line: #cdd8dd;
    --accent: #0e6b63; --accent-ink: #ffffff; --error: #b3261e; --error-bg: #fbeceb;
    --ok: #0e6b63; --ok-bg: #e3f3f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1a20; --panel: #16252d; --ink: #e6eef1; --muted: #91a5af; --line: #2a3d47;
      --accent: #4fc3b5; --accent-ink: #0a1a1f; --error: #ff9c94; --error-bg: #3a1f1d;
      --ok: #4fc3b5; --ok-bg: #12312f;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font: 16px/1.55 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    min-height: 100vh; padding: 48px 20px;
  }
  main { max-width: 600px; margin: 0 auto; }
  h1 { font: 600 2rem/1.15 Georgia, "Iowan Old Style", "Times New Roman", serif; letter-spacing: -0.01em; margin: 0 0 8px; }
  .lead { color: var(--muted); margin: 0 0 20px; max-width: 52ch; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
  .status { display: inline-flex; align-items: center; gap: 8px; font-size: .9rem; color: var(--muted); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); }
  .dot.ok { background: var(--ok); }
  .dot.bad { background: var(--error); }
  form { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
  label.field { display: block; font-weight: 600; margin-bottom: 6px; }
  input[type=password], select {
    width: 100%; font: 16px/1.4 inherit; padding: 11px 12px; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  }
  input:focus-visible, button:focus-visible, select:focus-visible {
    outline: 3px solid var(--accent); outline-offset: 2px;
  }
  .row { margin-top: 22px; }
  fieldset { border: 0; padding: 0; margin: 0; }
  legend { font-weight: 600; margin-bottom: 8px; padding: 0; }
  .opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; cursor: pointer; }
  .opt:has(input:checked) { border-color: var(--accent); }
  .opt input { margin-top: 5px; accent-color: var(--accent); }
  .opt b { display: block; font-weight: 600; }
  .opt span { color: var(--muted); font-size: .88rem; }
  .check { display: flex; gap: 10px; align-items: center; cursor: pointer; }
  .check input { accent-color: var(--accent); width: 17px; height: 17px; }
  button.primary {
    font: 600 1rem/1 inherit; background: var(--accent); color: var(--accent-ink);
    border: 0; border-radius: 6px; padding: 14px 20px; cursor: pointer; width: 100%; margin-top: 26px;
  }
  button.primary:disabled { opacity: .6; cursor: progress; }
  button.link { background: none; border: 0; color: var(--muted); text-decoration: underline; cursor: pointer; font: inherit; font-size: .9rem; padding: 4px; }
  .msg { margin-top: 18px; padding: 12px 14px; border-radius: 6px; font-size: .95rem; display: none; }
  .msg.show { display: block; }
  .msg.ok { background: var(--ok-bg); color: var(--ok); }
  .msg.err { background: var(--error-bg); color: var(--error); }
  .msg.info { background: var(--bg); color: var(--muted); border: 1px solid var(--line); }
  .msg pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; font: 12.5px/1.5 ui-monospace, Consolas, monospace; }
  footer { color: var(--muted); font-size: .85rem; margin-top: 24px; max-width: 58ch; }
`;

const LOGIN_HTML = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Entrar</title>
<style>${CSS}</style></head>
<body><main>
  <h1>Backup do Postgres</h1>
  <p class="lead">Digite a senha de acesso para continuar.</p>
  <form id="form">
    <label class="field" for="pw">Senha</label>
    <input type="password" id="pw" autocomplete="current-password" required autofocus>
    <button class="primary" type="submit" id="go">Entrar</button>
    <div class="msg" id="msg" role="alert"></div>
  </form>
</main>
<script>
(function () {
  var msg = document.getElementById('msg'), btn = document.getElementById('go');
  document.getElementById('form').addEventListener('submit', function (e) {
    e.preventDefault();
    btn.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pg-backup' },
      body: JSON.stringify({ password: document.getElementById('pw').value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (r.ok) { location.reload(); return; }
        msg.className = 'msg show err';
        msg.textContent = r.d.error || 'Não foi possível entrar.';
        btn.disabled = false;
      })
      .catch(function () {
        msg.className = 'msg show err';
        msg.textContent = 'Sem conexão com o servidor.';
        btn.disabled = false;
      });
  });
})();
</script></body></html>`;

const APP_HTML = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Backup do Postgres</title>
<style>${CSS}</style></head>
<body><main>
  <h1>Backup do Postgres</h1>
  <p class="lead">Escolha o formato e baixe o backup do banco direto para o seu computador.</p>

  <div class="top">
    <div class="status" id="status"><span class="dot"></span><span>Verificando pg_dump…</span></div>
    <button class="link" id="logout" type="button">Sair</button>
  </div>

  <form id="form">
    <div id="dbBox" hidden>
      <label class="field" for="db">Banco</label>
      <select id="db"></select>
    </div>

    <fieldset class="row" id="fmtBox">
      <legend>Formato do arquivo</legend>
      <label class="opt"><input type="radio" name="format" value="custom" checked>
        <div><b>Custom (.dump)</b><span>Compacto. Restaure com pg_restore. Recomendado.</span></div></label>
      <label class="opt"><input type="radio" name="format" value="sqlgz">
        <div><b>SQL compactado (.sql.gz)</b><span>Texto SQL em gzip. Restaure com psql.</span></div></label>
      <label class="opt"><input type="radio" name="format" value="sql">
        <div><b>SQL puro (.sql)</b><span>Legível, mas grande. Restaure com psql.</span></div></label>
    </fieldset>

    <div class="row">
      <label class="check"><input type="checkbox" id="noOwner" checked>
        <span>Ignorar donos e permissões (facilita restaurar em outro servidor)</span></label>
    </div>

    <button class="primary" type="submit" id="go" disabled>Fazer backup e baixar</button>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </form>

  <footer>O arquivo é montado na memória do navegador antes de ser salvo. Para bancos com vários GB, prefira rodar o pg_dump no terminal.</footer>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var msg = $('msg'), btn = $('go');

  function setMsg(kind, text, detail) {
    msg.className = 'msg show ' + kind;
    msg.textContent = text;
    if (detail) { var pre = document.createElement('pre'); pre.textContent = detail; msg.appendChild(pre); }
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  fetch('/api/info').then(function (r) {
    if (r.status === 401) { location.reload(); return null; }
    return r.json();
  }).then(function (s) {
    if (!s) return;
    var el = $('status');
    el.querySelector('.dot').className = 'dot ' + (s.installed ? 'ok' : 'bad');
    el.querySelector('span:last-child').textContent = s.installed ? s.version + ' encontrado' : 'pg_dump não encontrado no servidor.';
    if (!s.databases.length) {
      setMsg('err', 'Nenhum banco configurado.', 'Defina a variável de ambiente DATABASE_URL no servidor.');
      return;
    }
    var sel = $('db');
    s.databases.forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
    if (s.databases.length > 1) $('dbBox').hidden = false;
    btn.disabled = !s.installed;
  });

  $('logout').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'pg-backup' } }).then(function () { location.reload(); });
  });

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    btn.disabled = true;
    setMsg('info', 'Conectando ao banco…');
    var filename = 'backup.dump';

    fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pg-backup' },
      body: JSON.stringify({
        db: $('db').value,
        format: document.querySelector('input[name=format]:checked').value,
        noOwner: $('noOwner').checked
      })
    }).then(function (res) {
      if (res.status === 401) { location.reload(); throw new Error('Sessão expirada.'); }
      if (!res.ok) {
        return res.json().catch(function () { return { error: 'Erro desconhecido.' }; })
          .then(function (d) { var err = new Error(d.title || 'Não foi possível fazer o backup.'); err.detail = d.error; throw err; });
      }
      var m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      if (m) filename = m[1];
      var reader = res.body.getReader(), chunks = [], total = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value); total += r.value.length;
          setMsg('info', 'Baixando… ' + fmt(total));
          return pump();
        });
      }
      return pump().then(function () { return { chunks: chunks, total: total }; });
    }).then(function (out) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(out.chunks));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 15000);
      setMsg('ok', 'Backup concluído: ' + filename + ' (' + fmt(out.total) + ').');
    }).catch(function (err) {
      setMsg('err', err.message || 'Falha no backup.', err.detail);
    }).then(function () { btn.disabled = false; });
  });
})();
</script></body></html>`;

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, obj, extra) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, html) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20_000) { reject(new Error('Corpo da requisição muito grande.')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function pgDumpVersion() {
  try {
    const r = spawnSync(PG_DUMP, ['--version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim();
  } catch { return null; }
}

function userError(title, error) {
  const e = new Error(title);
  e.title = title;
  e.userMessage = error;
  return e;
}

function parseConnection(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^psql\s+/i, '').replace(/^['"]+|['"]+$/g, '').trim();
  let u;
  try { u = new URL(s); } catch {
    throw userError('Connection string inválida', 'Confira o valor configurado no servidor (formato postgresql://usuario:senha@host/banco).');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname || !u.pathname || u.pathname === '/') {
    throw userError('Connection string incompleta', 'Confira o valor configurado no servidor.');
  }
  const env = {
    ...process.env,
    PGHOST: u.hostname.replace(/-pooler(?=\.)/, ''), // o pooler atrapalha o pg_dump
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get('sslmode') || 'require',
    PGCONNECT_TIMEOUT: '30',
  };
  // Não repassa segredos do app para o processo filho
  delete env.APP_PASSWORD; delete env.SESSION_SECRET; delete env.DATABASE_URL;
  for (const k of Object.keys(env)) if (/^DB_[A-Z0-9_]+$/.test(k)) delete env[k];
  const cb = u.searchParams.get('channel_binding');
  if (cb) env.PGCHANNELBINDING = cb;
  return { env, database: env.PGDATABASE };
}

function explain(stderr) {
  const tips = [];
  if (/server version mismatch/i.test(stderr)) tips.push('O pg_dump do servidor é mais antigo que o Postgres do Neon. Aumente PG_VERSION no Dockerfile e faça um novo deploy.');
  if (/password authentication failed/i.test(stderr)) tips.push('Usuário ou senha do banco incorretos. Atualize DATABASE_URL no servidor.');
  if (/could not translate host name|Name or service not known/i.test(stderr)) tips.push('Host do banco não encontrado. Confira DATABASE_URL.');
  if (/timeout|timed out/i.test(stderr)) tips.push('Tempo esgotado ao conectar. O projeto do Neon pode estar suspenso ou com restrição de IP.');
  return tips.join('\n');
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

async function handleLogin(req, res) {
  if (req.headers['x-requested-with'] !== 'pg-backup') return sendJson(res, 403, { error: 'Requisição recusada.' });
  const ip = clientIp(req);
  const wait = blockedFor(ip);
  if (wait) return sendJson(res, 429, { error: `Muitas tentativas. Tente de novo em ${wait} min.` });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Requisição inválida.' }); }

  if (!passwordOk(body && body.password)) {
    registerFail(ip);
    return sendJson(res, 401, { error: 'Senha incorreta.' });
  }
  attempts.delete(ip);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeToken(), SESSION_HOURS * 3600) });
}

let running = 0;

async function handleBackup(req, res) {
  if (req.headers['x-requested-with'] !== 'pg-backup') return sendJson(res, 403, { title: 'Requisição recusada', error: 'Cabeçalho de segurança ausente.' });
  if (running >= MAX_CONCURRENT_BACKUPS) return sendJson(res, 429, { title: 'Backup em andamento', error: 'Já existe um backup rodando. Aguarde terminar.' });

  let payload, conn, dbName;
  try {
    payload = JSON.parse(await readBody(req));
    dbName = String(payload.db || '');
    if (!Object.prototype.hasOwnProperty.call(DATABASES, dbName)) throw userError('Banco desconhecido', 'Escolha um banco da lista.');
    conn = parseConnection(DATABASES[dbName]);
  } catch (e) {
    return sendJson(res, 400, { title: e.title || 'Requisição inválida', error: e.userMessage || e.message });
  }

  const format = ['custom', 'sql', 'sqlgz'].includes(payload.format) ? payload.format : 'custom';
  const args = [format === 'custom' ? '-Fc' : '-Fp'];
  if (payload.noOwner) args.push('--no-owner', '--no-privileges');

  const safeDb = conn.database.replace(/[^\w.-]+/g, '_') || 'db';
  const ext = { custom: 'dump', sql: 'sql', sqlgz: 'sql.gz' }[format];
  const mime = format === 'sqlgz' ? 'application/gzip' : 'application/octet-stream';
  const filename = `${safeDb}_${timestamp()}.${ext}`;

  running += 1;
  let released = false;
  const release = () => { if (!released) { released = true; running -= 1; } };
  console.log(`[backup] iniciado: banco="${dbName}" formato=${format}`);

  const child = spawn(PG_DUMP, args, { env: conn.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', started = false, out = null, finished = false;

  child.stderr.on('data', (c) => { if (stderr.length < 20_000) stderr += c.toString(); });

  child.on('error', (err) => {
    if (finished) return;
    finished = true; release();
    if (err.code === 'ENOENT') return sendJson(res, 500, { title: 'pg_dump não encontrado', error: 'O servidor não tem o pg_dump instalado. Confira o Dockerfile.' });
    sendJson(res, 500, { title: 'Erro ao iniciar o pg_dump', error: err.message });
  });

  child.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      if (format === 'sqlgz') { out = zlib.createGzip(); out.pipe(res); } else { out = res; }
    }
    if (!out.write(chunk)) {
      child.stdout.pause();
      out.once('drain', () => child.stdout.resume());
    }
  });

  child.on('close', (code) => {
    release();
    if (finished) return;
    finished = true;
    console.log(`[backup] finalizado: banco="${dbName}" codigo=${code}`);
    if (code !== 0) {
      if (!started) {
        const hint = explain(stderr);
        return sendJson(res, 500, { title: 'O pg_dump falhou', error: (hint ? hint + '\n\n' : '') + stderr.trim() });
      }
      return res.destroy(); // falhou no meio: evita salvar arquivo incompleto como se estivesse ok
    }
    if (!started) return sendJson(res, 500, { title: 'Backup vazio', error: stderr.trim() || 'O pg_dump não retornou dados.' });
    out.end();
  });

  res.on('close', () => { if (!res.writableFinished && !finished) child.kill(); });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method === 'GET' && path === '/') return sendHtml(res, isAuthed(req) ? APP_HTML : LOGIN_HTML);

    if (req.method === 'POST' && path === '/api/login') return await handleLogin(req, res);

    if (req.method === 'POST' && path === '/api/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    // Tudo abaixo exige login
    if (path.startsWith('/api/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { title: 'Sessão expirada', error: 'Entre novamente.' });

      if (req.method === 'GET' && path === '/api/info') {
        const version = pgDumpVersion();
        return sendJson(res, 200, { installed: !!version, version, databases: Object.keys(DATABASES) });
      }
      if (req.method === 'POST' && path === '/api/backup') return await handleBackup(req, res);
    }

    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { title: 'Erro interno', error: 'Algo deu errado no servidor.' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const v = pgDumpVersion();
  console.log(`Postgres Backup ouvindo em ${HOST}:${PORT}`);
  console.log(v ? `${v} encontrado` : 'ATENÇÃO: pg_dump não encontrado.');
  console.log(`Bancos configurados: ${Object.keys(DATABASES).join(', ') || 'nenhum (defina DATABASE_URL)'}`);
});
