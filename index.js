const express = require("express");
const { Pool } = require("pg");
const app = express();
app.use(express.urlencoded({ extended: true }));
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const a = fn => (req, res, next) => fn(req, res, next).catch(next);

const ESTADOS = ["Recibido","En revisión","Presupuesto enviado","Aceptado","En obra","Terminado"];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const codigo = id => "JP " + String(id).padStart(4, "0");
async function enviarEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return;
  const body = {
    from: process.env.FROM_EMAIL || "Reformas JP <onboarding@resend.dev>",
    to,
    subject,
    html
  };
  if (process.env.INBOUND_EMAIL) body.reply_to = process.env.INBOUND_EMAIL;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
}
async function avisar(id, s) {
  if (!process.env.NOTIFY_EMAIL) return;
  await enviarEmail({
    to: process.env.NOTIFY_EMAIL,
    subject: `Nueva solicitud ${codigo(id)}: ${s.tipo || ""}`,
    html: `<h2>Nueva solicitud ${codigo(id)}</h2><p><b>${esc(s.nombre)}</b><br>${esc(s.email)}<br>${esc(s.telefono)}</p><p><b>${esc(s.tipo)}</b> ${s.metros ? esc(s.metros) + " m2" : ""}</p><p>${esc(s.descripcion)}</p>`
  });
}
const page = body => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reformas JP</title>
<style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:20px}
input,select,textarea,button{width:100%;padding:10px;margin:6px 0;font-size:16px;box-sizing:border-box}
button{background:#ffca08;color:#0f0e0c;font-weight:bold;border:0;border-radius:6px;cursor:pointer}
table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}
.marca{background:#0f0e0c;border-radius:10px;padding:18px 20px;margin-bottom:20px;display:flex;justify-content:center}
.logo{display:flex;align-items:center;gap:12px}
.nombre{font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:34px;color:#fff;border-bottom:4px solid #ffca08;line-height:1.15;padding-bottom:2px}
.lema{color:#fff;font-size:10px;letter-spacing:5px;margin-top:6px;font-family:Arial,sans-serif}
.jp{width:64px;height:64px;border-radius:50%;background:#ffca08;color:#0f0e0c;font-weight:900;font-size:28px;display:flex;align-items:center;justify-content:center;font-family:'Arial Black',Arial,sans-serif;flex-shrink:0}
h1{color:#0f0e0c;border-left:6px solid #ffca08;padding-left:10px}
th{background:#0f0e0c;color:#fff}</style>
</head><body><header class="marca"><div class="logo"><div><div class="nombre">Reformas</div><div class="lema">REFORMAS Y DISEÑO</div></div><div class="jp">JP</div></div></header>${body}</body></html>`;

// Formulario para clientes
app.get("/", (req, res) => res.send(page(`
<h1>Pide tu presupuesto de reforma</h1>
<form method="post" action="/solicitud">
<input name="nombre" placeholder="Nombre" required>
<input name="email" type="email" placeholder="Email" required>
<input name="telefono" placeholder="Teléfono">
<select name="tipo" required><option value="" disabled selected>Selecciona una opción</option><option>Cocina</option><option>Baño</option>
<option>Vivienda completa</option><option>Local</option><option>Otro</option></select>
<input name="metros" type="number" step="any" placeholder="Metros cuadrados">
<textarea name="descripcion" rows="4" placeholder="Cuéntanos qué quieres hacer"></textarea>
<button>Enviar solicitud</button></form>`)));

app.post("/solicitud", a(async (req, res) => {
  const { nombre, email, telefono, tipo, metros, descripcion } = req.body;
  const r = await db.query(
    "INSERT INTO solicitudes (nombre,email,telefono,tipo,metros,descripcion) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [nombre, email, telefono, tipo, metros || null, descripcion]);
  const id = r.rows[0].id;
  avisar(id, req.body).catch(e => console.error("Email:", e.message));
  enviarEmail({
    to: email,
    subject: `Hemos recibido tu solicitud ${codigo(id)}`,
    html: `<p>Hola ${esc(nombre)},</p><p>Hemos recibido tu solicitud.</p><p>Código: <b>${codigo(id)}</b><br>Estado: <b>Recibido</b></p><p>Si quieres añadir algo, responde a este email.</p><p>Reformas JP</p>`
  }).catch(e => console.error("Email cliente:", e.message));
  res.send(page(`<h1>¡Gracias, ${esc(nombre)}!</h1>
<p>Tu número de solicitud es <b>${codigo(id)}</b>. Te contactaremos pronto.</p>`));
}));

// Panel interno con contraseña
function auth(req, res, next) {
  const b64 = (req.headers.authorization || "").split(" ")[1] || "";
  const s = Buffer.from(b64, "base64").toString();
  const pass = s.slice(s.indexOf(":") + 1);
  if (process.env.ADMIN_PASSWORD && pass === process.env.ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="panel"').status(401).send("Acceso restringido");
}

app.get("/panel", auth, a(async (req, res) => {
  const { rows } = await db.query("SELECT s.*, (SELECT COUNT(*) FROM mensajes m WHERE m.solicitud_id = s.id)::int AS n_mensajes FROM solicitudes s ORDER BY s.id DESC");
  const filas = rows.map(s => `<tr><td>${codigo(s.id)}<br>${new Date(s.creada).toLocaleDateString("es")}<br><a href="/panel/solicitud/${s.id}">Ver (${s.n_mensajes} mensajes)</a></td>
<td>${esc(s.nombre)}<br>${esc(s.email)}<br>${esc(s.telefono)}</td>
<td><b>${esc(s.tipo)}</b> ${s.metros ? esc(s.metros) + " m²" : ""}<br>${esc(s.descripcion)}</td>
<td><form method="post" action="/panel/estado"><input type="hidden" name="id" value="${s.id}">
<select name="estado">${ESTADOS.map(e => `<option ${e === s.estado ? "selected" : ""}>${e}</option>`).join("")}</select>
<button>Guardar</button></form></td></tr>`).join("");
  res.send(page(`<h1>Panel de contrataciones</h1><p>${rows.length} solicitudes</p>
<table><tr><th>Nº</th><th>Cliente</th><th>Reforma</th><th>Estado</th></tr>${filas}</table>`));
}));

app.get("/panel/solicitud/:id", auth, a(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(404).send("No encontrado");
  const { rows } = await db.query("SELECT * FROM solicitudes WHERE id=$1", [id]);
  const s = rows[0];
  if (!s) return res.status(404).send("No encontrado");
  const msgs = (await db.query("SELECT * FROM mensajes WHERE solicitud_id=$1 ORDER BY creado ASC", [id])).rows;
  const lista = msgs.length
    ? msgs.map(m => `<div style="border:1px solid #ccc;border-radius:6px;padding:10px;margin:10px 0">
<small>${esc(new Date(m.creado).toLocaleString("es"))} — ${esc(m.de)}</small>
<div style="white-space:pre-wrap">${esc(m.texto)}</div></div>`).join("")
    : "<p>Todavía no hay mensajes.</p>";
  res.send(page(`<p><a href="/panel">← Volver al panel</a></p>
<h1>Solicitud ${esc(codigo(id))}</h1>
<p><b>Fecha:</b> ${esc(new Date(s.creada).toLocaleString("es"))}<br>
<b>Nombre:</b> ${esc(s.nombre)}<br>
<b>Email:</b> ${esc(s.email)}<br>
<b>Teléfono:</b> ${esc(s.telefono)}<br>
<b>Tipo:</b> ${esc(s.tipo)}<br>
<b>Metros:</b> ${s.metros ? esc(s.metros) + " m²" : ""}<br>
<b>Descripción:</b> ${esc(s.descripcion)}<br>
<b>Estado:</b> ${esc(s.estado)}</p>
<h2>Mensajes del cliente</h2>${lista}
<p><a href="/panel">← Volver al panel</a></p>`));
}));

app.post("/panel/estado", auth, a(async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const estado = req.body.estado;
  if (!Number.isNaN(id)) {
    const row = (await db.query("SELECT * FROM solicitudes WHERE id=$1", [id])).rows[0];
    if (row && ESTADOS.includes(estado) && estado !== row.estado) {
      await db.query("UPDATE solicitudes SET estado=$1 WHERE id=$2", [estado, id]);
      enviarEmail({
        to: row.email,
        subject: `Tu solicitud ${codigo(id)}: ${estado}`,
        html: `<p>Hola ${esc(row.nombre)},</p><p>El estado de tu solicitud ${codigo(id)} ha cambiado a: <b>${esc(estado)}</b></p><p>Si tienes cualquier duda, responde a este email.</p><p>Reformas JP</p>`
      }).catch(e => console.error("Email estado:", e.message));
    }
  }
  res.redirect("/panel");
}));

// Respuestas de clientes (Resend inbound)
app.post("/webhooks/resend", express.json(), a(async (req, res) => {
  if (process.env.WEBHOOK_TOKEN && req.query.token !== process.env.WEBHOOK_TOKEN)
    return res.sendStatus(401);
  if (req.body?.type !== "email.received" || !req.body.data?.email_id)
    return res.sendStatus(200);
  try {
    const emailId = req.body.data.email_id;
    const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
    });
    if (!r.ok) {
      console.error("Webhook email:", await r.text());
      return res.sendStatus(200);
    }
    const e = await r.json();
    const subject = e.subject || "";
    const from = e.from || "";
    let texto = e.text || String(e.html || "").replace(/<[^>]+>/g, "");
    const cut = texto.match(/^(On .+wrote:|El .+escribi[oó]:)/m);
    if (cut) texto = texto.slice(0, cut.index);
    texto = texto.split("\n").filter(l => !l.startsWith(">")).join("\n").trim();
    const m = subject.match(/JP\s*-?\s*(\d{1,6})/i) || texto.match(/JP\s*-?\s*(\d{1,6})/i);
    if (m) {
      const id = parseInt(m[1], 10);
      const found = await db.query("SELECT id FROM solicitudes WHERE id=$1", [id]);
      if (found.rows.length) {
        await db.query("INSERT INTO mensajes (solicitud_id, de, asunto, texto) VALUES ($1,$2,$3,$4)", [id, from, subject, texto]);
        if (process.env.NOTIFY_EMAIL) {
          await enviarEmail({
            to: process.env.NOTIFY_EMAIL,
            subject: `Nuevo mensaje en ${codigo(id)}`,
            html: `<p><b>${esc(from)}</b></p><p style="white-space:pre-wrap">${esc(texto)}</p>`
          });
        }
      } else {
        console.log("Mensaje entrante sin solicitud:", codigo(id), from);
      }
    } else {
      console.log("Mensaje entrante sin código de solicitud:", from, subject);
    }
  } catch (err) {
    console.error("Webhook resend:", err.message);
  }
  res.sendStatus(200);
}));

// Crea las tablas si no existen y arranca
db.query(`CREATE TABLE IF NOT EXISTS solicitudes (
  id SERIAL PRIMARY KEY, nombre TEXT, email TEXT, telefono TEXT, tipo TEXT,
  metros NUMERIC, descripcion TEXT, estado TEXT DEFAULT 'Recibido', creada TIMESTAMP DEFAULT NOW())`)
  .then(() => db.query(`CREATE TABLE IF NOT EXISTS mensajes (id SERIAL PRIMARY KEY, solicitud_id INT REFERENCES solicitudes(id), de TEXT, asunto TEXT, texto TEXT, creado TIMESTAMP DEFAULT NOW())`))
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("App lista")));
