const express = require("express");
const { Pool } = require("pg");
const app = express();
app.use(express.urlencoded({ extended: true }));
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const a = fn => (req, res, next) => fn(req, res, next).catch(next);

const ESTADOS = ["Recibido","En revisión","Presupuesto enviado","Aceptado","En obra","Terminado"];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function avisar(id, s) {
 if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return;
 const res = await fetch("https://api.resend.com/emails", {
 method: "POST",
 headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 from: "Reformas <onboarding@resend.dev>",
 to: process.env.NOTIFY_EMAIL,
 subject: `Nueva solicitud #${id}: ${s.tipo || ""}`,
 html: `<h2>Nueva solicitud #${id}</h2><p><b>${esc(s.nombre)}</b><br>${esc(s.email)}<br>${esc(s.telefono)}</p><p><b>${esc(s.tipo)}</b> ${s.metros ? esc(s.metros) + " m2" : ""}</p><p>${esc(s.descripcion)}</p>`
 })
 });
 if (!res.ok) throw new Error(await res.text());
}
const page = body => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reformas</title>
<style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:20px}
input,select,textarea,button{width:100%;padding:10px;margin:6px 0;font-size:16px;box-sizing:border-box}
button{background:#1f6f43;color:#fff;border:0;border-radius:6px}
table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}</style>
</head><body>${body}</body></html>`;

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
 avisar(r.rows[0].id, req.body).catch(e => console.error("Email:", e.message));
  res.send(page(`<h1>¡Gracias, ${esc(nombre)}!</h1>
<p>Tu número de solicitud es <b>#${r.rows[0].id}</b>. Te contactaremos pronto.</p>`));
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
  const { rows } = await db.query("SELECT * FROM solicitudes ORDER BY id DESC");
  const filas = rows.map(s => `<tr><td>#${s.id}<br>${new Date(s.creada).toLocaleDateString("es")}</td>
<td>${esc(s.nombre)}<br>${esc(s.email)}<br>${esc(s.telefono)}</td>
<td><b>${esc(s.tipo)}</b> ${s.metros ? esc(s.metros) + " m²" : ""}<br>${esc(s.descripcion)}</td>
<td><form method="post" action="/panel/estado"><input type="hidden" name="id" value="${s.id}">
<select name="estado">${ESTADOS.map(e => `<option ${e === s.estado ? "selected" : ""}>${e}</option>`).join("")}</select>
<button>Guardar</button></form></td></tr>`).join("");
  res.send(page(`<h1>Panel de contrataciones</h1><p>${rows.length} solicitudes</p>
<table><tr><th>Nº</th><th>Cliente</th><th>Reforma</th><th>Estado</th></tr>${filas}</table>`));
}));

app.post("/panel/estado", auth, a(async (req, res) => {
  if (ESTADOS.includes(req.body.estado))
    await db.query("UPDATE solicitudes SET estado=$1 WHERE id=$2", [req.body.estado, req.body.id]);
  res.redirect("/panel");
}));

// Crea la tabla si no existe y arranca
db.query(`CREATE TABLE IF NOT EXISTS solicitudes (
  id SERIAL PRIMARY KEY, nombre TEXT, email TEXT, telefono TEXT, tipo TEXT,
  metros NUMERIC, descripcion TEXT, estado TEXT DEFAULT 'Recibido', creada TIMESTAMP DEFAULT NOW())`)
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("App lista")));
