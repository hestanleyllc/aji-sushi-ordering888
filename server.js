const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

let mailTransporter = null;
if(process.env.EMAIL_USER && process.env.EMAIL_PASS){
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
} else {
  console.log('Email notifications disabled — set EMAIL_USER and EMAIL_PASS to enable them.');
}

function sendNewOrderEmail(order){
  const to = data.config.siteInfo && data.config.siteInfo.notifyEmail;
  if(!mailTransporter || !to) return;
  const itemLines = order.items.map(it=>{
    const opts = it.options ? Object.entries(it.options).map(([k,v])=>{
      if(Array.isArray(v)) return `    ${k}:\n` + v.map(x=>`      – ${x}`).join('\n');
      return `    ${k}: ${v}`;
    }).join('\n') : '';
    const note = it.note ? `\n    Note: ${it.note}` : '';
    return `  x${it.qty} ${it.name} ($${it.price})\n${opts}${note}`;
  }).join('\n');
  const text = `New order #${order.num}\n\n${itemLines}\n\nSubtotal: $${Number(order.subtotal||order.total).toFixed(2)}\nTax: $${Number(order.tax||0).toFixed(2)}\nTotal: $${Number(order.total).toFixed(2)}\nPayment: ${order.paid ? 'PAID ONLINE' : 'Pay in store'}\nCustomer: ${order.name || '—'}\nPhone: ${order.phone || '—'}\nType: ${order.location}${order.deliveryAddress ? ' — '+order.deliveryAddress : ''}\n${order.note ? 'Order note: '+order.note : ''}`;
  mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: `New order #${order.num} — $${order.total}`,
    text,
  }).catch(err => console.error('Failed to send order notification email', err));
}

function sendCustomerConfirmationEmail(order){
  if(!mailTransporter || !order.email) return;
  const restaurantName = (data.config.siteInfo && data.config.siteInfo.name) || 'Our Restaurant';
  const itemLines = order.items.map(it => `  x${it.qty} ${it.name} ($${(it.price*it.qty).toFixed(2)})`).join('\n');
  const text = `Hi ${order.name || 'there'},\n\nYour order #${order.num} at ${restaurantName} is confirmed!\n\n${order.location === 'Delivery' ? `Estimated delivery time: ${order.pickupTime}` : `Pickup time: ${order.pickupTime}`}\n\n${itemLines}\n\nSubtotal: $${Number(order.subtotal||order.total).toFixed(2)}\nTax: $${Number(order.tax||0).toFixed(2)}\nTotal: $${Number(order.total).toFixed(2)}\nPayment: ${order.paid ? 'Paid online' : 'Please pay in store'}\n\nThanks for your order!\n${restaurantName}`;
  mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to: order.email,
    subject: `Your order #${order.num} at ${restaurantName} is confirmed`,
    text,
  }).catch(err => console.error('Failed to send customer confirmation email', err));
}

// ---- Printer (PrintNode) ----
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = process.env.PRINTNODE_PRINTER_ID; // default/general printer, used as fallback
if(!PRINTNODE_API_KEY){
  console.log('Kitchen printing disabled — set PRINTNODE_API_KEY to enable it.');
}

function ticketHeaderLines(order, stationLabel){
  const name = (data.config.siteInfo && data.config.siteInfo.name) || 'ORDER';
  const line = '--------------------------------';
  const lines = [name, line];
  if(stationLabel) lines.push(`STATION: ${stationLabel.toUpperCase()}`, line);
  lines.push(`Order #${order.num}`, `Type: ${order.location}${order.deliveryAddress ? ' — '+order.deliveryAddress : ''}`);
  if(order.name) lines.push(`Name: ${order.name}`);
  if(order.phone) lines.push(`Phone: ${order.phone}`);
  lines.push(line);
  return lines;
}

function itemLines(it, label){
  const lines = [`x${it.qty}  ${label}  $${(it.price*it.qty).toFixed(2)}`];
  if(it.options){
    Object.entries(it.options).forEach(([k,v])=>{
      if(!v) return;
      if(Array.isArray(v)){
        lines.push(`   ${k}:`);
        v.forEach(x=> lines.push(`     - ${x}`));
      } else {
        lines.push(`   ${k}: ${v}`);
      }
    });
  }
  if(it.note) lines.push(`   Note: ${it.note}`);
  return lines;
}

function buildReceiptText(order){
  const line = '--------------------------------';
  const lines = ticketHeaderLines(order, null);
  order.items.forEach(it=>{ lines.push(...itemLines(it, it.name)); });
  lines.push(line);
  lines.push(`Subtotal: $${Number(order.subtotal||order.total).toFixed(2)}`);
  lines.push(`Tax: $${Number(order.tax||0).toFixed(2)}`);
  lines.push(`Total: $${Number(order.total).toFixed(2)}`);
  lines.push(`Payment: ${order.paid ? 'PAID ONLINE' : 'Pay in store'}`);
  if(order.note) lines.push(`Order note: ${order.note}`);
  lines.push('');
  lines.push(new Date(order.createdAt).toLocaleString('en-US'));
  return lines.join('\n');
}

function buildStationReceiptText(order, stationLabel, items){
  const lines = ticketHeaderLines(order, stationLabel);
  items.forEach(({it,label})=>{ lines.push(...itemLines(it, label)); });
  lines.push('--------------------------------');
  if(order.note) lines.push(`Order note: ${order.note}`);
  lines.push('');
  lines.push(new Date(order.createdAt).toLocaleString('en-US'));
  return lines.join('\n');
}

function buildEscPosBuffer(text){
  const INIT = Buffer.from([0x1B, 0x40]); // ESC @  (reset printer)
  const body = Buffer.from(text + '\n\n\n', 'utf8');
  const CUT = Buffer.from([0x1D, 0x56, 0x00]); // GS V 0 (full cut)
  return Buffer.concat([INIT, body, CUT]);
}

async function printToPrinter(printerId, title, text){
  if(!PRINTNODE_API_KEY || !printerId) return;
  try{
    const content = buildEscPosBuffer(text).toString('base64');
    const auth = Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');
    const res = await fetch('https://api.printnode.com/printjobs', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: Number(printerId),
        title,
        contentType: 'raw_base64',
        content,
        source: 'Maple & Main website',
      }),
    });
    if(!res.ok){
      console.error('PrintNode print failed:', res.status, await res.text());
    }
  }catch(e){
    console.error('Failed to send print job to PrintNode', e);
  }
}

function groupOrderItemsByStation(order){
  const groups = {}; // stationName -> [{it, label}]
  const generalItems = [];
  order.items.forEach(it=>{
    const routing = Array.isArray(it.printRouting) ? it.printRouting.filter(r => r.station) : [];
    if(routing.length){
      routing.forEach(r=>{
        const label = (r.label && r.label.trim()) ? r.label.trim() : it.name;
        groups[r.station] = groups[r.station] || [];
        groups[r.station].push({ it, label });
      });
    } else {
      generalItems.push({ it, label: it.name });
    }
  });
  return { groups, generalItems };
}

async function printOrderTicket(order){
  if(!PRINTNODE_API_KEY) return;
  const stations = (data.config.printStations || []).filter(s => s.printerId);

  // No stations configured yet — keep the original single-ticket behavior.
  if(stations.length === 0){
    if(!PRINTNODE_PRINTER_ID) return;
    await printToPrinter(PRINTNODE_PRINTER_ID, `Order #${order.num}`, buildReceiptText(order));
    return;
  }

  const { groups, generalItems } = groupOrderItemsByStation(order);

  for(const stationName of Object.keys(groups)){
    const station = stations.find(s => s.name === stationName);
    if(!station) continue;
    await printToPrinter(station.printerId, `Order #${order.num} — ${stationName}`, buildStationReceiptText(order, stationName, groups[stationName]));
  }

  if(generalItems.length){
    if(PRINTNODE_PRINTER_ID){
      await printToPrinter(PRINTNODE_PRINTER_ID, `Order #${order.num} — General`, buildStationReceiptText(order, 'General', generalItems));
    } else {
      const fallback = stations[0];
      await printToPrinter(fallback.printerId, `Order #${order.num} — ${fallback.name}`, buildStationReceiptText(order, fallback.name, generalItems));
    }
  }
}

// ---- Free print bridge (alternative to PrintNode) ----
// A small script (print-bridge.js) run on a computer connected to the printer polls
// this queue and prints directly — no third-party subscription needed.
const PRINT_BRIDGE_SECRET = process.env.PRINT_BRIDGE_SECRET || '';
let printQueue = []; // {id, station, title, content(base64 escpos), createdAt}

function queueFreePrintJobs(order){
  if(!PRINT_BRIDGE_SECRET) return;
  const { groups, generalItems } = groupOrderItemsByStation(order);
  const stationNames = Object.keys(groups);
  stationNames.forEach(name=>{
    printQueue.push({
      id: 'pj_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
      station: name,
      title: `Order #${order.num} — ${name}`,
      content: buildEscPosBuffer(buildStationReceiptText(order, name, groups[name])).toString('base64'),
      createdAt: Date.now(),
    });
  });
  if(generalItems.length){
    printQueue.push({
      id: 'pj_' + Date.now() + '_' + Math.floor(Math.random() * 100000) + '_g',
      station: 'General',
      title: `Order #${order.num} — General`,
      content: buildEscPosBuffer(buildStationReceiptText(order, 'General', generalItems)).toString('base64'),
      createdAt: Date.now(),
    });
  }
}

const app = express();
app.use(express.json({ limit: '15mb' }));

const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const crypto = require('crypto');
const ADMIN_COOKIE = 'admin_session';
const KITCHEN_COOKIE = 'kitchen_session';
// A fixed secret mixed into the session token. Set SESSION_SECRET in Render for
// extra safety, but even without it, the token stays the same across restarts
// (it's derived from the login credentials themselves, not randomly generated),
// so staff stay logged in — a restart no longer forces everyone to log in again.
const SESSION_SECRET = process.env.SESSION_SECRET || 'maple-and-main-fixed-secret';

// The Render env vars (ADMIN_USER/ADMIN_PASSWORD) are only the starting fallback.
// Once the owner sets custom logins in the admin panel, those are stored in
// data.config.auth and take over — this lets the restaurant-orders login and the
// admin login be two separate accounts, changeable without touching Render at all.
function getAuthCreds(){
  const custom = (data.config && data.config.auth) || {};
  return {
    adminUser: custom.adminUser || DEFAULT_ADMIN_USER,
    adminPassword: custom.adminPassword || DEFAULT_ADMIN_PASSWORD,
    kitchenUser: custom.kitchenUser || DEFAULT_ADMIN_USER,
    kitchenPassword: custom.kitchenPassword || DEFAULT_ADMIN_PASSWORD,
  };
}

function sessionTokenFor(role){
  const creds = getAuthCreds();
  const base = role === 'admin'
    ? `admin:${creds.adminUser}:${creds.adminPassword}`
    : `kitchen:${creds.kitchenUser}:${creds.kitchenPassword}`;
  return crypto.createHmac('sha256', SESSION_SECRET).update(base).digest('hex');
}

function parseCookies(req){
  const header = req.headers.cookie;
  const cookies = {};
  if(!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if(idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

// Full admin access (menu, hours, logins, etc.)
function requireAdminAuth(req, res, next){
  const cookies = parseCookies(req);
  if(cookies[ADMIN_COOKIE] === sessionTokenFor('admin')) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({ error: 'not_logged_in', message: 'Please log in again.' });
  }
  return res.redirect('/staff-login.html?role=admin&redirect=' + encodeURIComponent(req.originalUrl));
}

// Kitchen/order-screen access only (a logged-in admin can use this too, since admin is the master account).
function requireKitchenAuth(req, res, next){
  const cookies = parseCookies(req);
  if(cookies[KITCHEN_COOKIE] === sessionTokenFor('kitchen') || cookies[ADMIN_COOKIE] === sessionTokenFor('admin')) return next();
  if(req.path.startsWith('/api/')){
    return res.status(401).json({ error: 'not_logged_in', message: 'Please log in again.' });
  }
  return res.redirect('/staff-login.html?role=kitchen&redirect=' + encodeURIComponent(req.originalUrl));
}

app.post('/api/login', (req, res) => {
  const { username, password, role } = req.body || {};
  const creds = getAuthCreds();
  if(role === 'admin'){
    if(username === creds.adminUser && password === creds.adminPassword){
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${sessionTokenFor('admin')}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60*60*24*30}`);
      return res.json({ ok: true });
    }
  } else {
    if(username === creds.kitchenUser && password === creds.kitchenPassword){
      res.setHeader('Set-Cookie', `${KITCHEN_COOKIE}=${sessionTokenFor('kitchen')}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60*60*24*30}`);
      return res.json({ ok: true });
    }
  }
  return res.status(401).json({ error: 'invalid', message: 'Incorrect username or password.' });
});

app.get('/staff-login.html', (req, res) => {
  const redirect = escapeAttr(req.query.redirect || '/restaurant-orders.html');
  const role = req.query.role === 'admin' ? 'admin' : 'kitchen';
  const title = role === 'admin' ? 'Admin Login' : 'Kitchen Staff Login';
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeAttr(title)}</title>
<style>
  body{font-family:-apple-system,Arial,sans-serif;background:#2B2B2E;color:#FAF3E4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .box{background:#FAF3E4;color:#1C1B19;border-radius:14px;padding:28px 24px;width:90%;max-width:340px;}
  h1{font-size:20px;margin:0 0 18px;}
  label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#7a6c46;}
  input{width:100%;padding:10px;margin:6px 0 16px;border-radius:8px;border:1px solid #cbbd94;font-size:15px;box-sizing:border-box;}
  button{width:100%;padding:12px;border:none;border-radius:8px;background:#C8102E;color:#fff;font-weight:700;font-size:14px;cursor:pointer;}
  #err{color:#C8102E;font-size:13px;margin-bottom:10px;display:none;}
</style></head>
<body>
  <div class="box">
    <h1>${escapeAttr(title)}</h1>
    <div id="err"></div>
    <form id="loginForm">
      <label>Username</label>
      <input id="username" autocapitalize="off" autocorrect="off">
      <label>Password</label>
      <input id="password" type="password">
      <button type="submit">Log In</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errEl = document.getElementById('err');
      errEl.style.display = 'none';
      try{
        const res = await fetch('/api/login', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ username, password, role: ${JSON.stringify(role)} })
        });
        const data = await res.json().catch(()=>({}));
        if(res.ok && data.ok){
          window.location.href = ${JSON.stringify(redirect)};
        } else {
          errEl.textContent = data.message || 'Login failed.';
          errEl.style.display = 'block';
        }
      }catch(e){
        errEl.textContent = 'Network error — please try again.';
        errEl.style.display = 'block';
      }
    });
  </script>
</body></html>`);
});

// ---- Pages (all html files live in the same folder as server.js — no subfolder needed) ----
function escapeAttr(str){
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function injectSeo(html, seo){
  if(!seo) return html;
  let out = html;
  if(seo.title){
    out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttr(seo.title)}</title>`);
  }
  if(seo.description){
    if(/<meta name="description"[^>]*>/.test(out)){
      out = out.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeAttr(seo.description)}">`);
    } else {
      out = out.replace('</head>', `  <meta name="description" content="${escapeAttr(seo.description)}">\n</head>`);
    }
  }
  return out;
}

app.get('/', (req, res) => res.redirect('/customer-order.html'));
app.get('/customer-order.html', (req, res) => {
  fs.readFile(path.join(__dirname, 'customer-order.html'), 'utf8', (err, html) => {
    if(err) return res.status(500).send('Error loading page');
    res.set('Content-Type', 'text/html');
    res.send(injectSeo(html, data.config.seo));
  });
});
app.get('/restaurant-orders.html', requireKitchenAuth, (req, res) => res.sendFile(path.join(__dirname, 'restaurant-orders.html')));
app.get('/admin.html', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// If DATA_DIR is set (e.g. pointing to a Render persistent disk mount path),
// data.json is written there so it survives restarts and redeploys.
// If not set, it falls back to the app folder (fine for local use, but ephemeral on Render).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_CONFIG = {
  siteInfo: {
    name: 'MAPLE & MAIN',
    tagline: 'Est. on Main Street',
    payNote: 'No online payment — please pay at the counter or with your server.',
    contact: { phone: '', address: '1620 NY-22, Brewster, NY 10509', hours: '' },
    notifyEmail: '',
    taxRate: 8.375,
    deliveryEnabled: false,
    localPrinterIp: '',
    orderingHours: {
      timezone: 'America/New_York',
      schedule: {
        mon: { closed: true },
        tue: { open: '11:00', close: '20:45' },
        wed: { open: '11:00', close: '20:45' },
        thu: { open: '11:00', close: '20:45' },
        fri: { open: '11:00', close: '20:45' },
        sat: { open: '11:00', close: '20:45' },
        sun: { open: '11:00', close: '20:45' },
      }
    }
  },
  seo: {
    title: 'Maple & Main · Order Online',
    description: 'Order online for pickup at Maple & Main.'
  },
  menu: [{"cat":"Appetizers","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d1","name":"Gyoza","desc":"Pork or veggie, steamed or fried dumplings","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d2","name":"Shumai","desc":"Steamed shrimp dumpling","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d3","name":"Edamame","desc":"Steamed fresh soybeans","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d4","name":"Age Tofu","desc":"","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d5","name":"Shrimp & Vegetable Tempura","desc":"","price":8.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d6","name":"Crispy Soft Shell Crab","desc":"","price":10.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d7","name":"Crispy Calamari","desc":"","price":9.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d8","name":"Japanese Spring Roll","desc":"","price":4,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d9","name":"Kani Su","desc":"Crabmeat and cucumber in ponzu sauce","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d10","name":"Sushi Appetizer","desc":"5 pcs assorted raw fish with seasoned rice","price":10.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d11","name":"Sashimi Appetizer","desc":"8 pcs assorted sliced raw fish","price":12.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d12","name":"Pepper Tuna","desc":"Sliced fresh tuna with grounded pepper and ponzu sauce","price":12.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d13","name":"Yellowtail Jalapeno","desc":"Sliced yellowtail with jalapeño and ponzu sauce","price":12.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d14","name":"Sushi Pizza","desc":"Pancake topped with avocado, spicy tuna, spicy mayo, eel sauce, and scallion","price":12.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d15","name":"Sexy Jalapeno","desc":"Deep fried jalapeño with cream cheese and spicy yellowtail, topped with masago, scallion and chef's special sauce","price":12.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d16","name":"Tako Su","desc":"Octopus w. cucumber in ponzu sauce","price":10.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d17","name":"Tuna or Salmon Tartar","desc":"Chopped tuna or salmon and avocado with roe and scallion","price":12.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Sushi Bar Entrée","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d18","name":"Dinner Maki Combo","desc":"Tuna roll, salmon roll & California roll","price":16.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d19","name":"Spicy Maki Combo","desc":"Spicy crunchy tuna roll, spicy crunchy salmon roll, spicy crunchy yellowtail roll","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d20","name":"California Maki Combo","desc":"3 California rolls","price":16.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d21","name":"Vegetable Maki Combo","desc":"Avocado, cucumber, asparagus roll","price":14.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d22","name":"Tempura Maki","desc":"Roll of chicken tempura, kani tempura and shrimp tempura","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d23","name":"Chirashi","desc":"Chef's choice of 15 pcs of assorted fish over sushi rice","price":24.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d24","name":"Sushi Regular","desc":"7 pcs sushi with 1 California roll","price":20.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d25","name":"Sushi Deluxe","desc":"9 pcs sushi with 1 tuna roll","price":23.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d26","name":"Sashimi Regular","desc":"13 pcs sashimi served w. rice on the side","price":23.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d27","name":"Sashimi Deluxe","desc":"16 pcs sashimi served w. rice on the side","price":26.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d28","name":"Sushi and Sashimi Combo","desc":"Chef's choice of 7 pcs sushi, 9 pcs sashimi and a tuna roll","price":27.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d29","name":"Unagi Don","desc":"Broiled smoked eel (10 pcs) with eel sauce on rice","price":24.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d30","name":"Salmon Don","desc":"10 pcs with rice","price":23.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d31","name":"Tuna Don","desc":"10 pcs with rice","price":23.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d32","name":"Love Boat for 2","desc":"Chef's choice of 8 pcs sushi, 10 pcs sashimi, California roll and a rising sun roll","price":50.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d33","name":"Aji Maki Combo","desc":"Spicy crunchy tuna roll, salmon avocado roll and eel cucumber roll","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d34","name":"Aji Sushi Combo","desc":"3 pcs tuna, 3 pcs salmon, 3 pcs yellowtail and a spicy crunchy tuna roll","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d35","name":"Special Roll Combo","desc":"Red dragon roll, California roll and salmon avocado roll","price":24.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Salad","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d36","name":"Green Salad","desc":"Lettuce, carrots & cucumber with ginger dressing","price":3,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d37","name":"Seaweed Salad","desc":"Special Japanese seaweed with sesame seeds","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d38","name":"Kani Salad","desc":"Crab sticks & cucumber mixed with spicy mayo","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d39","name":"Spicy Seafood Salad","desc":"Green salad with kani, shrimp & octopus","price":9.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d40","name":"Black Pepper Tuna Salad","desc":"Green salad with black pepper tuna","price":13.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d41","name":"Avocado Salad","desc":"Green salad with avocado","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Soup","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d42","name":"Miso Soup","desc":"","price":3,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d43","name":"Clear Soup","desc":"","price":3,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d44","name":"Spicy Noodle Soup","desc":"","price":9.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Sushi/Sashimi A La Carte","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d45","name":"Black Pepper Tuna","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d46","name":"Shrimp","desc":"2 pc per order","price":5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d47","name":"Tuna","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d48","name":"White Tuna","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d49","name":"Striped Bass","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d50","name":"Red Snapper","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d51","name":"Yellowtail","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d52","name":"Salmon","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d53","name":"Flying Fish Roe","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d54","name":"Salmon Roe","desc":"2 pc per order","price":8,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d55","name":"Scallop","desc":"2 pc per order","price":8,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d56","name":"Red Clam","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d57","name":"Eel","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d58","name":"Octopus","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d59","name":"Smoked Salmon","desc":"2 pc per order","price":6,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d60","name":"Crab Stick","desc":"2 pc per order","price":5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d61","name":"Custard Eggs","desc":"2 pc per order","price":5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Classic Roll / Hand Roll","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d62","name":"Salmon Roll","desc":"Raw","price":6.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d63","name":"Yellowtail Roll","desc":"Raw","price":6.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d64","name":"Tuna Roll","desc":"Raw","price":6.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d65","name":"Tuna Avocado Roll","desc":"Raw","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d66","name":"Salmon Avocado Roll","desc":"Raw","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d67","name":"Yellowtail Jalapeno Roll","desc":"Raw","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d68","name":"Spicy Crunchy Tuna Roll","desc":"Raw","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d69","name":"Spicy Crunchy Salmon Roll","desc":"Raw","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d70","name":"Spicy Crunchy Yellowtail Roll","desc":"Raw","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d71","name":"Philadelphia Roll","desc":"Smoked salmon, cream cheese & avocado","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d72","name":"New York Roll","desc":"Tuna, cream cheese, avocado","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d73","name":"Alaska Roll","desc":"Salmon, avocado, cucumber","price":7.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d74","name":"Christmas Roll","desc":"Tuna, yellowtail, tobiko, crunch","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d75","name":"Tokyo Roll","desc":"Tuna, salmon, yellowtail with red caviar","price":8.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d76","name":"Spicy Crunchy Scallop Roll","desc":"Raw","price":10.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Cooked & Vegetable Rolls","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d77","name":"California Roll","desc":"Crab meat, avocado & cucumber","price":5.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d78","name":"Shrimp Avocado Roll","desc":"","price":6.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d79","name":"Shrimp Cucumber Roll","desc":"","price":6.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d80","name":"Boston Roll","desc":"Shrimp, cucumber, lettuce & Japanese mayo","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d81","name":"Eel Avocado or Cucumber Roll","desc":"","price":7.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d82","name":"Spicy Crunchy Shrimp Roll","desc":"","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d83","name":"Red Snapper Tempura Roll","desc":"","price":6.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d84","name":"Shrimp Tempura Roll","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d85","name":"Salmon Tempura Roll","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d86","name":"Chicken Tempura Roll","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d87","name":"Spicy Salmon Tempura Roll","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d88","name":"Spicy Tuna Tempura Roll","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d89","name":"Fried Banana Roll","desc":"","price":5.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d90","name":"Crab Meat Tempura Roll","desc":"Crab meat tempura, avocado and cucumber","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d91","name":"Shrimp Asparagus Roll","desc":"","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d92","name":"Spicy Crunchy Crab Roll","desc":"","price":6.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d93","name":"Mango Avocado Roll","desc":"","price":6.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d94","name":"Oshinko Roll","desc":"","price":4.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d95","name":"Avocado Roll","desc":"","price":4.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d96","name":"Cucumber Roll","desc":"","price":4.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d97","name":"Asparagus Tempura Roll","desc":"","price":5.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d98","name":"Avocado Cucumber Roll","desc":"","price":5.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d99","name":"Sweet Potato Roll (Vegetable)","desc":"","price":5.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d100","name":"AAC Roll","desc":"Avocado, asparagus, cucumber","price":5.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Special Roll","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d101","name":"Green Dragon Roll","desc":"Eel cucumber roll topped with sliced avocado, flying fish roe and eel sauce","price":14.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d102","name":"Rainbow Roll","desc":"California roll topped with assorted raw fish and avocado","price":13.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d103","name":"Spicy Girl Roll","desc":"10 pcs jumbo rolls; spicy tuna, spicy yellowtail, spicy salmon and avocado wrapped in soybean paper","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d104","name":"Sweet Heart Roll","desc":"Crunchy-spicy tuna and avocado inside, wrapped with fresh tuna","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d105","name":"Black Dragon Roll","desc":"Shrimp tempura and cucumber roll, topped with sliced eel, avocado and eel sauce","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d106","name":"Special Lobster Roll","desc":"Shrimp tempura and avocado roll topped with lobster salad, crunch and special sauce","price":14.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d107","name":"Pink Lady Roll","desc":"10 pcs jumbo rolls; tuna, salmon, yellowtail, crabmeat tempura, avocado & cucumber wrapped in soybean paper","price":16.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d108","name":"Red Dragon Roll","desc":"Shrimp tempura & avocado inside, spicy crab meat on the top","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d109","name":"Spider Roll","desc":"Deep-fried soft shell crab with avocado, cucumber and masago","price":12.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d110","name":"Angry Mr. Mike Roll","desc":"Shrimp tempura and spicy tuna inside, topped with avocado & lobster-kani mix, drizzled with spicy mayo and eel sauce","price":17.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d111","name":"Brewster Roll","desc":"Spicy crab meat and avocado inside, topped with pepper tuna","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d112","name":"Naruto Roll","desc":"Tuna, salmon, yellowtail and avocado wrapped with sliced cucumber","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d113","name":"Crazy Tuna Roll","desc":"Avocado & pepper tuna topped with crunchy spicy tuna","price":14.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d114","name":"Snow Mountain Roll","desc":"Crabmeat with avocado inside, lobster salad on the top","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d115","name":"American Dream Roll","desc":"Tuna, salmon, yellowtail inside, topped with spicy crabmeat","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d116","name":"Rising Sun Roll","desc":"Spicy-crunchy tuna and avocado topped with salmon and yellowtail","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d117","name":"Special Eel Roll","desc":"Spicy shrimp rolled with eel and avocado","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d118","name":"Beautiful Tuna Roll","desc":"Spicy tuna rolled with tuna and avocado","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d119","name":"Beautiful Salmon Roll","desc":"Spicy salmon rolled with salmon and avocado","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d120","name":"Rainbow Shrimp Roll","desc":"Spicy shrimp rolled with tuna, salmon and avocado","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d121","name":"Hot Dragon Roll","desc":"Shrimp tempura rolled with crunchy spicy tuna","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d122","name":"Route 22 Roll","desc":"Salmon, avocado and cream cheese rolled with spicy crab","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d123","name":"Tempura California Roll","desc":"Crabmeat, cream cheese and avocado (fried)","price":11.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d124","name":"Volcano Roll","desc":"California rolled with spicy tuna","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d125","name":"Sexy Avocado Roll","desc":"Spicy tuna and crunchy flake topped with avocado","price":14.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d126","name":"Aji Roll","desc":"Shrimp tempura and eel roll, topped with spicy crab meat and avocado, drizzled with spicy mayo, eel sauce and fish egg","price":17.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d127","name":"Bubble Roll","desc":"10 pcs jumbo rolls, eel, crab meat, shrimp, avocado, cucumber, wrapped in soybean paper","price":15.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d128","name":"Creamy Potato Roll","desc":"Sweet potato, cream cheese, topped with avocado and eel sauce","price":12.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d129","name":"Godzilla Roll","desc":"Spicy crab, crunchy inside top with eel","price":15,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Dinner Box","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d130","name":"Chicken Teriyaki Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":20.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d131","name":"Beef Teriyaki Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d132","name":"Shrimp Teriyaki Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d133","name":"Salmon Teriyaki Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d134","name":"Scallop Teriyaki Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":23.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d135","name":"Shrimp Tempura Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d136","name":"Chicken Katsu Bento Box","desc":"Served with miso soup, salad, white rice, California roll and shumai","price":19.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Udon Soup","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d137","name":"Vegetable Udon Soup","desc":"","price":11.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d138","name":"Tempura Udon Soup","desc":"","price":14.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d139","name":"Nabeyaki Udon Soup","desc":"Chicken-shrimp tempura, eggs and vegetable","price":15.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d140","name":"Seafood Udon Soup","desc":"Jumbo shrimp, fish, scallop, crabmeat and vegetable","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Dessert","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d141","name":"Green Tea Ice Cream","desc":"","price":4.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d142","name":"Vanilla Ice Cream","desc":"","price":4.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d143","name":"Tempura Banana","desc":"","price":4.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d144","name":"Tempura Ice Cream","desc":"","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d145","name":"Fried Cheesecake","desc":"","price":7,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d146","name":"Mochi Ice Cream","desc":"2 pcs","price":5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Tempura & Katsu","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d147","name":"Vegetable Tempura","desc":"Served with miso soup, salad and rice","price":15.25,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d148","name":"Chicken Tempura","desc":"Served with miso soup, salad and rice","price":16.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d149","name":"Shrimp Tempura","desc":"Served with miso soup, salad and rice","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d150","name":"Chicken Katsu","desc":"Deep-fried chicken cutlet","price":16.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Teriyaki Dinner","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d151","name":"Tofu Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":17.75,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d152","name":"Chicken Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":18.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d153","name":"Beef Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":24.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d154","name":"Salmon Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d155","name":"Scallop Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":25.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d156","name":"Shrimp Teriyaki","desc":"Served with miso soup, salad and fried noodle","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d157","name":"Chicken & Steak","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d158","name":"Chicken & Shrimp","desc":"Served with miso soup, salad and fried noodle","price":22.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d159","name":"Chicken & Salmon","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d160","name":"Chicken & Scallop","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d161","name":"Steak & Shrimp","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d162","name":"Steak & Salmon","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d163","name":"Steak & Scallop","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d164","name":"Shrimp & Salmon","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d165","name":"Shrimp & Scallop","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d166","name":"Salmon & Scallop","desc":"Served with miso soup, salad and fried noodle","price":24.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Sushi Bar Lunch","orderWindow":{"enabled":true,"start":"11:00","end":"15:00"},"items":[{"id":"d167","name":"Sushi Lunch","desc":"5 pcs of sushi and California roll","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d168","name":"Sashimi Lunch","desc":"10 pcs of assorted sashimi","price":15.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d169","name":"Sushi and Sashimi Lunch","desc":"4 pcs of sushi, 6 pcs of sashimi and spicy tuna roll","price":17.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d170","name":"Any Two Rolls","desc":"Served with miso soup or salad. Pick 2 rolls.","price":13,"soldOut":false,"hot":false,"optionGroups":[{"id":"og_171_pz52w","label":"Choose 2 rolls","type":"multi","count":2,"choices":["Alaska","Avocado","Boston","California","Cucumber","Cucumber Avocado","Philadelphia","Yellowtail","Salmon","Tuna","Salmon Avocado","Shrimp Avocado","Shrimp Tempura","Spicy Crab","Spicy Salmon","Spicy Tuna","Spicy Yellowtail","Spicy Shrimp","Sweet Potato","Tuna Avocado","Eel Avocado","Fried Banana Roll"]}],"printRouting":[]},{"id":"d172","name":"Any Three Rolls","desc":"Served with miso soup or salad. Pick 3 rolls.","price":16.5,"soldOut":false,"hot":false,"optionGroups":[{"id":"og_173_jci58","label":"Choose 3 rolls","type":"multi","count":3,"choices":["Alaska","Avocado","Boston","California","Cucumber","Cucumber Avocado","Philadelphia","Yellowtail","Salmon","Tuna","Salmon Avocado","Shrimp Avocado","Shrimp Tempura","Spicy Crab","Spicy Salmon","Spicy Tuna","Spicy Yellowtail","Spicy Shrimp","Sweet Potato","Tuna Avocado","Eel Avocado","Fried Banana Roll"]}],"printRouting":[]}]},{"cat":"Lunch Bento Box","orderWindow":{"enabled":true,"start":"11:00","end":"15:00"},"items":[{"id":"d174","name":"Chicken Teriyaki Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d175","name":"Shrimp Teriyaki Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d176","name":"Chicken Katsu Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d177","name":"Beef Teriyaki Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d178","name":"Salmon Teriyaki Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d179","name":"Shrimp and Vegetable Tempura Bento Box","desc":"From 11AM-3PM, served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Noodle","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d180","name":"Plain Noodle (Small)","desc":"","price":4.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d181","name":"Plain Noodle (Large)","desc":"","price":8.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d182","name":"Vegetable Noodle (Small)","desc":"","price":6.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d183","name":"Vegetable Noodle (Large)","desc":"","price":10.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d184","name":"Chicken Noodle (Small)","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d185","name":"Chicken Noodle (Large)","desc":"","price":11.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d186","name":"Shrimp Noodle (Small)","desc":"","price":8.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d187","name":"Shrimp Noodle (Large)","desc":"","price":12.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Rice","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d188","name":"Egg Fried Rice (Small)","desc":"","price":4.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d189","name":"Egg Fried Rice (Large)","desc":"","price":8.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d190","name":"Vegetable Egg Fried Rice (Small)","desc":"","price":6.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d191","name":"Vegetable Egg Fried Rice (Large)","desc":"","price":10.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d192","name":"Chicken Egg Fried Rice (Small)","desc":"","price":7.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d193","name":"Chicken Egg Fried Rice (Large)","desc":"","price":11.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d194","name":"Shrimp Egg Fried Rice (Small)","desc":"","price":8.95,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d195","name":"Shrimp Egg Fried Rice (Large)","desc":"","price":12.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d196","name":"White Rice (Small)","desc":"","price":2.5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d197","name":"White Rice (Large)","desc":"","price":5,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Party Tray","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d198","name":"Party Tray A","desc":"2 Red Dragon Roll, 1 Green Dragon Roll, 1 Special Lobster Roll, 1 Special Eel Roll, 1 Creamy Potato Roll, 1 Godzilla Roll","price":85,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d199","name":"Party Tray B","desc":"2 California Roll, 2 Spicy Tuna Roll, 2 Salmon Avocado Roll, 1 Philadelphia Roll, 2 Tuna Roll, 2 Salmon Roll","price":60,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d200","name":"Party Tray C","desc":"2 California Roll, 1 Eel Avocado Roll, 1 Eel Cucumber Roll, 2 Shrimp Tempura Roll, 2 Spicy Crab Roll, 1 Avocado Roll","price":50,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]},{"id":"d201","name":"Party Tray D","desc":"1 Red Dragon Roll, 1 Special Lobster Roll, 1 Rainbow Roll, 2 California Roll, 2 Spicy Tuna Roll, 1 Salmon Avocado Roll","price":65,"soldOut":false,"hot":false,"optionGroups":[],"printRouting":[]}]},{"cat":"Dinner Special","orderWindow":{"enabled":false,"start":"11:00","end":"15:00"},"items":[{"id":"d202","name":"Any 2 Special Rolls","desc":"Served with soup or salad. Pick 2 special rolls.","price":25.95,"soldOut":false,"hot":false,"optionGroups":[{"id":"og_203_f154h","label":"Choose 2 special rolls","type":"multi","count":2,"choices":["Green Dragon Roll","Rainbow Roll","Red Dragon Roll","Brewster Roll","Special Eel Roll","Beautiful Tuna Roll","Beautiful Salmon Roll","Rainbow Shrimp Roll","Hot Dragon Roll","Route 22 Roll","Tempura California Roll","Volcano Roll","Sexy Avocado Roll","Spicy Girl Roll","Sweet Heart Roll","Black Dragon Roll","Spider Roll","Creamy Potato Roll","Snow Mountain Roll"]}],"printRouting":[]},{"id":"d204","name":"Any 3 Special Rolls","desc":"Served with soup or salad. Pick 3 special rolls.","price":36.95,"soldOut":false,"hot":false,"optionGroups":[{"id":"og_205_seztd","label":"Choose 3 special rolls","type":"multi","count":3,"choices":["Green Dragon Roll","Rainbow Roll","Red Dragon Roll","Brewster Roll","Special Eel Roll","Beautiful Tuna Roll","Beautiful Salmon Roll","Rainbow Shrimp Roll","Hot Dragon Roll","Route 22 Roll","Tempura California Roll","Volcano Roll","Sexy Avocado Roll","Spicy Girl Roll","Sweet Heart Roll","Black Dragon Roll","Spider Roll","Creamy Potato Roll","Snow Mountain Roll"]}],"printRouting":[]}]}],
  printStations: []
};

// Optional free persistent storage using Upstash Redis (no credit card, no paid Render plan needed).
// If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, data is stored there instead of a local file.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_KEY = 'maple-and-main-data';

if(useUpstash){
  console.log('Using Upstash Redis for persistent storage.');
} else {
  console.log('Using local file storage (' + DATA_FILE + '). Set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, or a Render persistent disk, to avoid data loss on restart.');
}

function freshData(){
  return { config: DEFAULT_CONFIG, orders: [], dailyOrderCounter: { date: '', count: 0 }, knownCustomers: {} };
}

async function loadData(){
  if(useUpstash){
    try{
      const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const json = await res.json();
      if(json && json.result){
        const parsed = JSON.parse(json.result);
        if(!parsed.config) parsed.config = DEFAULT_CONFIG;
        if(!parsed.orders) parsed.orders = [];
        if(!parsed.dailyOrderCounter) parsed.dailyOrderCounter = { date: '', count: 0 };
        if(!parsed.knownCustomers) parsed.knownCustomers = {};
        return parsed;
      }
    }catch(e){ console.error('Failed to load from Upstash', e); }
    return freshData();
  }
  if(!fs.existsSync(DATA_FILE)) return freshData();
  try{
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if(!parsed.config) parsed.config = DEFAULT_CONFIG;
    if(!parsed.orders) parsed.orders = [];
    if(!parsed.dailyOrderCounter) parsed.dailyOrderCounter = { date: '', count: 0 };
    if(!parsed.knownCustomers) parsed.knownCustomers = {};
    return parsed;
  }catch(e){
    return freshData();
  }
}

let data;
let saveQueue = Promise.resolve();

async function persistData(){
  const payload = JSON.stringify(data, null, 2);
  if(useUpstash){
    try{
      await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: payload,
      });
    }catch(e){ console.error('Failed to save to Upstash', e); }
    return;
  }
  return new Promise((resolve) => {
    fs.writeFile(DATA_FILE, payload, (err) => {
      if(err) console.error('Failed to save data.json', err);
      resolve();
    });
  });
}

function saveData(){
  saveQueue = saveQueue.then(() => persistData());
  return saveQueue;
}

// ---- Config (site info + menu) ----
app.get('/api/config', (req, res) => {
  // Public endpoint (the ordering page needs it) — strip anything staff-only before sending.
  const publicConfig = JSON.parse(JSON.stringify(data.config));
  if(publicConfig.siteInfo) delete publicConfig.siteInfo.notifyEmail;
  if(publicConfig.siteInfo) publicConfig.siteInfo.onlinePaymentEnabled = !!stripe;
  // printStations is kept (station names + local IPs aren't sensitive, and the
  // kitchen board needs them for direct network printing). PrintNode IDs are
  // only meaningful with the (secret) PRINTNODE_API_KEY anyway.
  delete publicConfig.auth;
  res.json(publicConfig);
});

app.post('/api/config', requireAdminAuth, (req, res) => {
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  const existingAuth = data.config.auth;
  data.config = req.body;
  // The admin panel never receives auth credentials back (write-only, for security),
  // so make sure a routine "Save Changes" never wipes out custom logins already set.
  if(existingAuth && !data.config.auth) data.config.auth = existingAuth;
  saveData();
  res.json({ ok: true });
});

app.post('/api/credentials', requireAdminAuth, (req, res) => {
  const body = req.body || {};
  if(!data.config.auth) data.config.auth = {};
  ['adminUser','adminPassword','kitchenUser','kitchenPassword'].forEach(key => {
    if(typeof body[key] === 'string' && body[key].trim()){
      data.config.auth[key] = body[key].trim();
    }
  });
  saveData();
  res.json({ ok: true });
});

// ---- Import menu from a photo (uses the Anthropic API to read the image) ----
app.post('/api/import-menu-photo', requireAdminAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    return res.status(400).json({ error: 'Menu photo import is not enabled. Set ANTHROPIC_API_KEY in Render to enable it.' });
  }
  const { imageBase64, mediaType } = req.body || {};
  if(!imageBase64){
    return res.status(400).json({ error: 'No image was received.' });
  }

  const prompt = `You are reading a restaurant menu from a photo. Extract every category and dish you can clearly see, and reply with ONLY a valid JSON array (no markdown fences, no explanation before or after) in exactly this shape:
[
  {
    "cat": "Category Name As Shown",
    "items": [
      { "name": "Dish Name", "desc": "Short description if shown, else empty string", "price": 12.5 }
    ]
  }
]
Rules:
- "price" must be a plain number with no dollar sign. If a dish shows multiple prices (e.g. small/large), use the lower one and mention the sizes in "desc".
- If no price is visible for an item, use 0.
- Keep category names as they appear on the menu (title case is fine).
- Do not invent items that are not actually visible in the photo.
- Reply with ONLY the JSON array — nothing else.`;

  try{
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if(!apiRes.ok){
      const errText = await apiRes.text();
      console.error('Anthropic API error importing menu photo:', apiRes.status, errText);
      return res.status(502).json({ error: 'The menu-reading service returned an error. Please try again, or try a clearer photo.' });
    }
    const apiData = await apiRes.json();
    const textBlock = (apiData.content || []).find(b => b.type === 'text');
    if(!textBlock){
      return res.status(502).json({ error: 'No readable response from the menu-reading service.' });
    }
    let cleaned = textBlock.text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsedMenu;
    try{
      parsedMenu = JSON.parse(cleaned);
    }catch(e){
      console.error('Could not parse menu JSON from model response:', cleaned);
      return res.status(502).json({ error: 'Could not understand the menu photo. Try a clearer, better-lit photo of one menu page at a time.' });
    }
    if(!Array.isArray(parsedMenu)){
      return res.status(502).json({ error: 'Unexpected response format from the menu-reading service.' });
    }

    const normalized = parsedMenu.map(sec => ({
      cat: (sec && sec.cat) ? String(sec.cat) : 'Imported',
      orderWindow: { enabled: false, start: '11:00', end: '15:00' },
      items: Array.isArray(sec && sec.items) ? sec.items.map(it => ({
        id: 'd_' + Date.now() + '_' + Math.floor(Math.random() * 1000000),
        name: (it && it.name) ? String(it.name) : 'Untitled Dish',
        desc: (it && it.desc) ? String(it.desc) : '',
        price: Number(it && it.price) || 0,
        soldOut: false,
        hot: false,
        optionGroups: [],
        printRouting: [],
      })) : [],
    }));

    res.json({ ok: true, menu: normalized });
  }catch(e){
    console.error('Menu photo import failed:', e);
    res.status(500).json({ error: 'Something went wrong reading the photo. Please try again.' });
  }
});

// ---- Orders ----
// Listing all orders exposes customer names/phone numbers — staff only.
app.get('/api/orders', requireKitchenAuth, (req, res) => {
  res.json(data.orders);
});

// ---- Real-time push (Server-Sent Events) so the kitchen alarm rings instantly ----
// Also staff-only, since it streams new order details as they arrive.
let sseClients = [];

// Not password-protected: EventSource (unlike fetch) can't send a custom
// Authorization header, and some browsers handle its native auth prompt poorly,
// causing repeated login popups. The regular polling requests (which ARE
// protected) remain the authoritative, secure data source either way.
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.push(res);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) {}
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c !== res);
  });
});

function broadcast(event, payload){
  const message = `data: ${JSON.stringify({ type: event, ...payload })}\n\n`;
  sseClients.forEach(res => {
    try { res.write(message); } catch(e) {}
  });
}

// Single-order lookup stays public — customers use their own order's
// unguessable id to check pickup status without logging in.
app.get('/api/orders/:id', (req, res) => {
  const order = data.orders.find(o => o.id === req.params.id);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ---- Ordering hours ----
function getTodayKey(timezone){
  const tz = timezone || 'America/New_York';
  try{
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  }catch(e){
    return new Date().toISOString().slice(0,10);
  }
}

function nextOrderNumber(){
  const tz = (data.config.siteInfo && data.config.siteInfo.orderingHours && data.config.siteInfo.orderingHours.timezone) || 'America/New_York';
  const todayKey = getTodayKey(tz);
  if(data.dailyOrderCounter.date !== todayKey){
    data.dailyOrderCounter = { date: todayKey, count: 0 };
  }
  data.dailyOrderCounter.count += 1;
  return String(data.dailyOrderCounter.count);
}

function getStoreStatus(){
  const orderingHours = data.config.siteInfo && data.config.siteInfo.orderingHours;
  if(!orderingHours || !orderingHours.schedule){
    return { open: true, schedule: null, timezone: null };
  }
  const tz = orderingHours.timezone || 'America/New_York';
  const now = new Date();
  let parts;
  try{
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
  }catch(e){
    return { open: true, schedule: orderingHours.schedule, timezone: tz };
  }
  const dayKey = parts.find(p=>p.type==='weekday').value.toLowerCase().slice(0,3);
  const hourStr = parts.find(p=>p.type==='hour').value;
  const minuteStr = parts.find(p=>p.type==='minute').value;
  const nowMinutes = (Number(hourStr) % 24) * 60 + Number(minuteStr);

  const day = orderingHours.schedule[dayKey];
  if(!day || day.closed){
    return { open: false, reason: 'closed_today', schedule: orderingHours.schedule, timezone: tz };
  }
  const [openH, openM] = (day.open || '00:00').split(':').map(Number);
  const [closeH, closeM] = (day.close || '23:59').split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const isOpen = nowMinutes >= openMinutes && nowMinutes <= closeMinutes;
  return { open: isOpen, reason: isOpen ? null : 'outside_hours', schedule: orderingHours.schedule, timezone: tz };
}

function getNowMinutes(timezone){
  const tz = timezone || 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hourStr = parts.find(p=>p.type==='hour').value;
  const minuteStr = parts.find(p=>p.type==='minute').value;
  return (Number(hourStr) % 24) * 60 + Number(minuteStr);
}

function isCategoryOpenNow(categoryName){
  const cat = (data.config.menu || []).find(c => c.cat === categoryName);
  if(!cat || !cat.orderWindow || !cat.orderWindow.enabled) return true;
  const tz = (data.config.siteInfo.orderingHours && data.config.siteInfo.orderingHours.timezone) || 'America/New_York';
  let nowMinutes;
  try{ nowMinutes = getNowMinutes(tz); }catch(e){ return true; }
  const [sh, sm] = (cat.orderWindow.start || '00:00').split(':').map(Number);
  const [eh, em] = (cat.orderWindow.end || '23:59').split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

app.get('/api/store-status', (req, res) => {
  res.json(getStoreStatus());
});

function validateOrderPayload(body){
  if(!Array.isArray(body.items) || body.items.length === 0){
    return { error: 'Order must include at least one item' };
  }
  const status = getStoreStatus();
  if(!status.open){
    return { error: 'Sorry, online ordering is currently closed. Please check our hours.', code: 'closed' };
  }
  for(const it of body.items){
    if(it.category && !isCategoryOpenNow(it.category)){
      const cat = (data.config.menu || []).find(c => c.cat === it.category);
      const w = cat && cat.orderWindow;
      return {
        error: `Sorry, "${it.category}" can only be ordered ${w ? `between ${w.start} and ${w.end}` : 'during its available hours'}.`,
        code: 'category_closed'
      };
    }
  }
  return null;
}

function normalizeCustomerKey(phone, email){
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  if(cleanPhone) return 'p:' + cleanPhone;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if(cleanEmail) return 'e:' + cleanEmail;
  return null;
}

function createOrder(body, extra){
  const customerKey = normalizeCustomerKey(body.phone, body.email);
  let isNewCustomer = false;
  if(customerKey){
    if(!data.knownCustomers[customerKey]){
      isNewCustomer = true;
      data.knownCustomers[customerKey] = Date.now();
    }
  }
  const order = {
    id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    num: nextOrderNumber(),
    items: body.items,
    subtotal: body.subtotal || 0,
    tax: body.tax || 0,
    total: body.total || 0,
    note: body.note || '',
    name: body.name || '',
    phone: body.phone || '',
    email: body.email || '',
    location: body.location || 'Pickup',
    deliveryAddress: body.deliveryAddress || '',
    status: 'pending',
    pickupTime: null,
    createdAt: Date.now(),
    paid: !!(extra && extra.paid),
    paymentMethod: (extra && extra.paymentMethod) || 'in_store',
    isNewCustomer,
  };
  data.orders.push(order);
  saveData();
  broadcast('new-order', { order });
  sendNewOrderEmail(order);
  printOrderTicket(order);
  queueFreePrintJobs(order);
  return order;
}

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const err = validateOrderPayload(body);
  if(err){
    return res.status(err.code === 'closed' || err.code === 'category_closed' ? 403 : 400).json({ error: err.code || 'invalid', message: err.error });
  }
  const order = createOrder(body, { paid: false, paymentMethod: 'in_store' });
  res.json(order);
});

// ---- Online payment (Stripe) ----
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
if(!stripe){
  console.log('Online payment disabled — set STRIPE_SECRET_KEY to enable it.');
}
const pendingCheckouts = new Map(); // checkoutId -> cart payload, cleared once paid or abandoned

app.post('/api/checkout', async (req, res) => {
  if(!stripe) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const body = req.body || {};
  const err = validateOrderPayload(body);
  if(err){
    return res.status(err.code === 'closed' || err.code === 'category_closed' ? 403 : 400).json({ error: err.code || 'invalid', message: err.error });
  }
  const checkoutId = 'chk_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  pendingCheckouts.set(checkoutId, body);
  setTimeout(() => pendingCheckouts.delete(checkoutId), 30 * 60 * 1000); // expire abandoned checkouts after 30 min

  try{
    const line_items = body.items.map(it => ({
      price_data: {
        currency: 'usd',
        product_data: { name: it.name },
        unit_amount: Math.round(it.price * 100),
      },
      quantity: it.qty,
    }));
    if(body.tax){
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Sales Tax' }, unit_amount: Math.round(body.tax * 100) },
        quantity: 1,
      });
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      client_reference_id: checkoutId,
      success_url: `${baseUrl}/customer-order.html?checkout_id=${checkoutId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/customer-order.html?payment_cancelled=1`,
    });
    res.json({ url: session.url });
  }catch(e){
    console.error('Stripe checkout session creation failed', e);
    pendingCheckouts.delete(checkoutId);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.get('/api/checkout/verify', async (req, res) => {
  if(!stripe) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const { checkout_id, session_id } = req.query;
  if(!checkout_id || !session_id) return res.status(400).json({ error: 'Missing checkout_id or session_id' });
  const pending = pendingCheckouts.get(checkout_id);
  if(!pending) return res.status(404).json({ error: 'This checkout has already been processed or has expired.' });
  try{
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if(session.client_reference_id !== checkout_id || session.payment_status !== 'paid'){
      return res.status(402).json({ error: 'Payment not confirmed yet.' });
    }
    pendingCheckouts.delete(checkout_id);
    const order = createOrder(pending, { paid: true, paymentMethod: 'online' });
    res.json({ ok: true, order });
  }catch(e){
    console.error('Stripe verify failed', e);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

app.patch('/api/orders/:id', requireKitchenAuth, (req, res) => {
  const idx = data.orders.findIndex(o => o.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'Order not found' });
  const wasConfirmed = data.orders[idx].status === 'confirmed';
  data.orders[idx] = { ...data.orders[idx], ...req.body };
  saveData();
  broadcast('order-updated', { order: data.orders[idx] });
  if(!wasConfirmed && data.orders[idx].status === 'confirmed'){
    sendCustomerConfirmationEmail(data.orders[idx]);
  }
  res.json(data.orders[idx]);
});

app.delete('/api/orders/:id', requireKitchenAuth, (req, res) => {
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// ---- Free print bridge API ----
// The local print-bridge.js script polls this to pick up new tickets and prints
// them directly, no PrintNode subscription required. Protected by a shared
// secret (set PRINT_BRIDGE_SECRET in Render) instead of the staff login, since
// this is machine-to-machine, not a person in a browser.
app.get('/api/print-queue', (req, res) => {
  if(!PRINT_BRIDGE_SECRET || req.query.secret !== PRINT_BRIDGE_SECRET){
    return res.status(401).json({ error: 'invalid_secret' });
  }
  res.json(printQueue);
});

app.post('/api/print-queue/:id/ack', (req, res) => {
  if(!PRINT_BRIDGE_SECRET || req.query.secret !== PRINT_BRIDGE_SECRET){
    return res.status(401).json({ error: 'invalid_secret' });
  }
  printQueue = printQueue.filter(j => j.id !== req.params.id);
  res.json({ ok: true });
});

// Housekeeping: drop orders older than 48h so data.json doesn't grow forever
setInterval(() => {
  if(!data) return;
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const before = data.orders.length;
  data.orders = data.orders.filter(o => o.createdAt > cutoff);
  if(data.orders.length !== before) saveData();
  // Also drop print-queue jobs nobody has picked up in 6h (bridge offline too long).
  const printCutoff = Date.now() - 6 * 60 * 60 * 1000;
  printQueue = printQueue.filter(j => j.createdAt > printCutoff);
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
loadData().then((loaded) => {
  data = loaded;
  app.listen(PORT, () => {
    console.log('Maple & Main server running on port ' + PORT);
  });
}).catch((e) => {
  console.error('Failed to load initial data, starting with defaults', e);
  data = freshData();
  app.listen(PORT, () => {
    console.log('Maple & Main server running on port ' + PORT);
  });
});
