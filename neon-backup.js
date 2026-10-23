#!/usr/bin/env node
/**
 * Neon Backup — app web local para fazer backup de bancos Postgres (Neon ou qualquer outro).
 *
 * Como usar:
 *   1. Instale o PostgreSQL client (precisa do comando `pg_dump`).
 *   2. Rode:  node neon-backup.js
 *   3. Abra:  http://localhost:3000
 *
 * Sem dependências npm. Só Node 18+ e pg_dump.
 * O servidor escuta apenas em 127.0.0.1 (somente a sua máquina acessa).
 * A connection string nunca é gravada em disco nem exibida em logs.
 */

const http = require('http');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PG_DUMP = process.env.PG_DUMP_PATH || 'pg_dump';

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backup do Postgres</title>
<style>
  :root {
    --bg: #eaf0f2;
    --panel: #ffffff;
    --ink: #13232c;
    --muted: #586b75;
    --line: #cdd8dd;
    --accent: #0e6b63;
    --accent-ink: #ffffff;
    --error: #b3261e;
    --error-bg: #fbeceb;
    --ok: #0e6b63;
    --ok-bg: #e3f3f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1a20;
      --panel: #16252d;
      --ink: #e6eef1;
      --muted: #91a5af;
      --line: #2a3d47;
      --accent: #4fc3b5;
      --accent-ink: #0a1a1f;
      --error: #ff9c94;
      --error-bg: #3a1f1d;
      --ok: #4fc3b5;
      --ok-bg: #12312f;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.55 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    min-height: 100vh;
    padding: 48px 20px;
  }
  main { max-width: 600px; margin: 0 auto; }
  h1 {
    font: 600 2rem/1.15 Georgia, "Iowan Old Style", "Times New Roman", serif;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
  }
  .lead { color: var(--muted); margin: 0 0 20px; max-width: 52ch; }
  .status {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: .9rem; color: var(--muted);
    margin-bottom: 20px;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); }
  .dot.ok { background: var(--ok); }
  .dot.bad { background: var(--error); }
  form {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 24px;
  }
  label.field { display: block; font-weight: 600; margin-bottom: 6px; }
  .hint { color: var(--muted); font-size: .88rem; margin: 6px 0 0; }
  input[type=password], input[type=text] {
    width: 100%;
    font: 14px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
    padding: 11px 12px;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  input:focus-visible, button:focus-visible, select:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }
  .row { margin-top: 22px; }
  fieldset { border: 0; padding: 0; margin: 0; }
  legend { font-weight: 600; margin-bottom: 8px; padding: 0; }
  .opt {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    margin-bottom: 8px;
    cursor: pointer;
  }
  .opt:has(input:checked) { border-color: var(--accent); }
  .opt input { margin-top: 5px; accent-color: var(--accent); }
  .opt b { display: block; font-weight: 600; }
  .opt span { color: var(--muted); font-size: .88rem; }
  .check { display: flex; gap: 10px; align-items: center; cursor: pointer; }
  .check input { accent-color: var(--accent); width: 17px; height: 17px; }
  button {
    font: 600 1rem/1 inherit;
    background: var(--accent);
    color: var(--accent-ink);
    border: 0;
    border-radius: 6px;
    padding: 14px 20px;
    cursor: pointer;
    width: 100%;
    margin-top: 26px;
  }
  button:disabled { opacity: .6; cursor: progress; }
  .msg {
    margin-top: 18px;
    padding: 12px 14px;
    border-radius: 6px;
    font-size: .95rem;
    display: none;
  }
  .msg.show { display: block; }
  .msg.ok { background: var(--ok-bg); color: var(--ok); }
  .msg.err { background: var(--error-bg); color: var(--error); }
  .msg.info { background: var(--bg); color: var(--muted); border: 1px solid var(--line); }
  .msg pre {
    white-space: pre-wrap; word-break: break-word;
    margin: 8px 0 0;
    font: 12.5px/1.5 ui-monospace, Consolas, monospace;
  }
  footer { color: var(--muted); font-size: .85rem; margin-top: 24px; max-width: 58ch; }
</style>
</head>
<body>
<main>
  <h1>Backup do Postgres</h1>
  <p class="lead">Cole a connection string do Neon, escolha o formato e baixe o backup direto para o seu computador.</p>

  <div class="status" id="status"><span class="dot"></span><span>Verificando pg_dump…</span></div>

  <form id="form" autocomplete="off">
    <label class="field" for="url">Connection string</label>
    <input type="password" id="url" required spellcheck="false"
           placeholder="postgresql://usuario:senha@ep-xxxx.aws.neon.tech/neondb?sslmode=require">
    <p class="hint">No painel do Neon: botão Connect. Se o host tiver “-pooler”, ele é trocado pela conexão direta automaticamente.</p>

    <fieldset class="row">
      <legend>Formato do arquivo</legend>
      <label class="opt">
        <input type="radio" name="format" value="custom" checked>
        <div><b>Custom (.dump)</b><span>Compacto. Restaure com pg_restore. Recomendado.</span></div>
      </label>
      <label class="opt">
        <input type="radio" name="format" value="sqlgz">
        <div><b>SQL compactado (.sql.gz)</b><span>Texto SQL em gzip. Restaure com psql.</span></div>
      </label>
      <label class="opt">
        <input type="radio" name="format" value="sql">
        <div><b>SQL puro (.sql)</b><span>Legível, mas grande. Restaure com psql.</span></div>
      </label>
    </fieldset>

    <div class="row">
      <label class="check">
        <input type="checkbox" id="noOwner" checked>
        <span>Ignorar donos e permissões (facilita restaurar em outro servidor)</span>
      </label>
    </div>

    <button type="submit" id="go">Fazer backup e baixar</button>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </form>

  <footer>
    A connection string é usada só para executar o pg_dump nesta máquina. Ela não é salva nem registrada.
    O arquivo é montado na memória do navegador antes de ser salvo, então para bancos com vários GB prefira rodar o pg_dump direto no terminal.
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var msg = $('msg'), btn = $('go');

  function setMsg(kind, text, detail) {
    msg.className = 'msg show ' + kind;
    msg.textContent = text;
    if (detail) {
      var pre = document.createElement('pre');
      pre.textContent = detail;
      msg.appendChild(pre);
    }
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    var el = $('status');
    el.querySelector('.dot').className = 'dot ' + (s.installed ? 'ok' : 'bad');
    el.querySelector('span:last-child').textContent = s.installed
      ? s.version + ' encontrado'
      : 'pg_dump não encontrado. Instale o PostgreSQL client e reinicie este programa.';
  }).catch(function () {});

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    btn.disabled = true;
    setMsg('info', 'Conectando ao banco…');

    var format = document.querySelector('input[name=format]:checked').value;
    var filename = 'backup.dump';

    fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'neon-backup' },
      body: JSON.stringify({ url: $('url').value, format: format, noOwner: $('noOwner').checked })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return { error: 'Erro desconhecido.' }; })
          .then(function (d) { var err = new Error(d.title || 'Não foi possível fazer o backup.'); err.detail = d.error; throw err; });
      }
      var m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      if (m) filename = m[1];

      var reader = res.body.getReader();
      var chunks = [], total = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value);
          total += r.value.length;
          setMsg('info', 'Baixando… ' + fmt(total));
          return pump();
        });
      }
      return pump().then(function () { return { chunks: chunks, total: total }; });
    }).then(function (out) {
      var blob = new Blob(out.chunks);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 15000);
      setMsg('ok', 'Backup concluído: ' + filename + ' (' + fmt(out.total) + ').');
    }).catch(function (err) {
      setMsg('err', err.message || 'Falha no backup.', err.detail);
    }).then(function () {
      btn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Lógica                                                              */
/* ------------------------------------------------------------------ */

function pgDumpVersion() {
  try {
    const r = spawnSync(PG_DUMP, ['--version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/** Aceita "postgresql://...", "psql 'postgresql://...'" e variações com aspas. */
function parseConnection(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^psql\s+/i, '').replace(/^['"]+|['"]+$/g, '').trim();

  let u;
  try {
    u = new URL(s);
  } catch {
    throw userError('Connection string inválida', 'Use o formato postgresql://usuario:senha@host/banco?sslmode=require');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    throw userError('Connection string inválida', 'Ela precisa começar com postgresql:// ou postgres://');
  }
  if (!u.hostname || !u.pathname || u.pathname === '/') {
    throw userError('Connection string incompleta', 'Faltou o host ou o nome do banco.');
  }

  const host = u.hostname.replace(/-pooler(?=\.)/, ''); // pooler (PgBouncer) atrapalha o pg_dump
  const database = decodeURIComponent(u.pathname.slice(1));

  const env = {
    ...process.env,
    PGHOST: host,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
    PGSSLMODE: u.searchParams.get('sslmode') || 'require',
    PGCONNECT_TIMEOUT: '30',
  };
  const cb = u.searchParams.get('channel_binding');
  if (cb) env.PGCHANNELBINDING = cb;

  return { env, database };
}

function userError(title, error) {
  const e = new Error(title);
  e.title = title;
  e.userMessage = error;
  return e;
}

function explain(stderr) {
  const tips = [];
  if (/server version mismatch|aborting because of server version mismatch/i.test(stderr)) {
    tips.push('Seu pg_dump é mais antigo que o Postgres do projeto Neon. Instale um cliente de versão igual ou superior.');
  }
  if (/password authentication failed/i.test(stderr)) {
    tips.push('Usuário ou senha incorretos. Copie a connection string de novo no painel do Neon.');
  }
  if (/could not translate host name|Name or service not known|not known/i.test(stderr)) {
    tips.push('Host não encontrado. Confira o endereço da connection string.');
  }
  if (/timeout|timed out/i.test(stderr)) {
    tips.push('Tempo esgotado. Confira sua internet e se o projeto do Neon não está suspenso ou bloqueado por IP.');
  }
  return tips.join('\n');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function handleBackup(req, res) {
  if (req.headers['x-requested-with'] !== 'neon-backup') {
    return sendJson(res, 403, { title: 'Requisição recusada', error: 'Cabeçalho de segurança ausente.' });
  }

  let payload, conn;
  try {
    payload = JSON.parse(await readBody(req));
    conn = parseConnection(payload.url);
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

  const child = spawn(PG_DUMP, args, { env: conn.env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let started = false;
  let out = null;
  let finished = false;

  child.stderr.on('data', (c) => {
    if (stderr.length < 20_000) stderr += c.toString();
  });

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    if (err.code === 'ENOENT') {
      return sendJson(res, 500, {
        title: 'pg_dump não encontrado',
        error: 'Instale o PostgreSQL client (ou defina PG_DUMP_PATH com o caminho do pg_dump) e reinicie.',
      });
    }
    sendJson(res, 500, { title: 'Erro ao iniciar o pg_dump', error: err.message });
  });

  child.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      if (format === 'sqlgz') {
        out = zlib.createGzip();
        out.pipe(res);
      } else {
        out = res;
      }
    }
    if (!out.write(chunk)) {
      child.stdout.pause();
      out.once('drain', () => child.stdout.resume());
    }
  });

  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    if (code !== 0) {
      if (!started) {
        const hint = explain(stderr);
        return sendJson(res, 500, {
          title: 'O pg_dump falhou',
          error: (hint ? hint + '\n\n' : '') + stderr.trim(),
        });
      }
      return res.destroy(); // falhou no meio: derruba a conexão para o navegador não salvar arquivo incompleto
    }
    if (!started) {
      return sendJson(res, 500, { title: 'Backup vazio', error: stderr.trim() || 'O pg_dump não retornou dados.' });
    }
    out.end();
  });

  // Se o usuário fechar a aba no meio, interrompe o pg_dump
  res.on('close', () => {
    if (!res.writableFinished && !finished) child.kill();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const version = pgDumpVersion();
      return sendJson(res, 200, { installed: !!version, version });
    }
    if (req.method === 'POST' && url.pathname === '/api/backup') {
      return await handleBackup(req, res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { title: 'Erro interno', error: e.message });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const v = pgDumpVersion();
  console.log(`\n  Neon Backup rodando em http://localhost:${PORT}`);
  console.log(v ? `  ${v} encontrado\n` : '  ATENÇÃO: pg_dump não encontrado no PATH.\n');
});
