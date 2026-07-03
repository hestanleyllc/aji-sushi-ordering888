const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

function requireAdminAuth(req, res, next){
  const authHeader = req.headers.authorization;
  if(!authHeader || !authHeader.startsWith('Basic ')){
    res.set('WWW-Authenticate', 'Basic realm="Maple & Main Admin"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const sep = decoded.indexOf(':');
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if(user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Maple & Main Admin"');
  return res.status(401).send('Invalid credentials');
}

// Protect the admin page itself
app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// Protect saving menu/site changes (reading config stays public — the ordering page needs it)
app.post('/api/config', requireAdminAuth, (req, res, next) => next());

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_CONFIG = {
  siteInfo: {
    name: 'MAPLE & MAIN',
    tagline: 'Est. on Main Street',
    payNote: 'No online payment — please pay at the counter or with your server.'
  },
  menu: [
    {cat:'Griddle & Eggs', items:[
      {id:'d1', name:'Buttermilk Pancake Stack', desc:'Three tall stack, warm maple syrup', price:11, soldOut:false},
      {id:'d2', name:'The Main Street Skillet', desc:'Eggs, hash browns, cheddar, peppers', price:13, soldOut:false},
    ]},
    {cat:'From the Grill', items:[
      {id:'d3', name:'Bacon Cheeseburger', desc:'Half-pound patty, smoked bacon, fries', price:15, soldOut:false},
      {id:'d4', name:'BBQ Pulled Pork Sandwich', desc:'Slow-smoked, house slaw, brioche bun', price:14, soldOut:false},
      {id:'d5', name:'Baked Mac & Cheese', desc:'Three-cheese blend, toasted crumb topping', price:12, soldOut:false},
    ]},
    {cat:'Fountain & Sides', items:[
      {id:'d6', name:'Hand-Spun Milkshake', desc:'Vanilla, chocolate, or strawberry', price:7, soldOut:false},
      {id:'d7', name:'Sweet Tea', desc:'Southern-style, brewed daily', price:3, soldOut:false},
      {id:'d8', name:'Slice of Apple Pie', desc:'Warm, with a scoop of vanilla', price:6, soldOut:false},
    ]},
  ]
};

function loadData(){
  if(!fs.existsSync(DATA_FILE)){
    return { config: DEFAULT_CONFIG, orders: [] };
  }
  try{
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if(!parsed.config) parsed.config = DEFAULT_CONFIG;
    if(!parsed.orders) parsed.orders = [];
    return parsed;
  }catch(e){
    return { config: DEFAULT_CONFIG, orders: [] };
  }
}

let data = loadData();
let saveQueue = Promise.resolve();
function saveData(){
  saveQueue = saveQueue.then(() => new Promise((resolve) => {
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
      if(err) console.error('Failed to save data.json', err);
      resolve();
    });
  }));
  return saveQueue;
}

// ---- Config (site info + menu) ----
app.get('/api/config', (req, res) => {
  res.json(data.config);
});

app.post('/api/config', (req, res) => {
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  data.config = req.body;
  saveData();
  res.json({ ok: true });
});

// ---- Orders ----
app.get('/api/orders', (req, res) => {
  res.json(data.orders);
});

app.get('/api/orders/:id', (req, res) => {
  const order = data.orders.find(o => o.id === req.params.id);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  if(!Array.isArray(body.items) || body.items.length === 0){
    return res.status(400).json({ error: 'Order must include at least one item' });
  }
  const order = {
    id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    num: String(Math.floor(100 + Math.random() * 900)),
    items: body.items,
    total: body.total || 0,
    note: body.note || '',
    name: body.name || '',
    location: body.location || 'Pickup',
    status: 'pending',
    pickupTime: null,
    createdAt: Date.now(),
  };
  data.orders.push(order);
  saveData();
  res.json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const idx = data.orders.findIndex(o => o.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'Order not found' });
  data.orders[idx] = { ...data.orders[idx], ...req.body };
  saveData();
  res.json(data.orders[idx]);
});

app.delete('/api/orders/:id', (req, res) => {
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// Housekeeping: drop orders older than 48h so data.json doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const before = data.orders.length;
  data.orders = data.orders.filter(o => o.createdAt > cutoff);
  if(data.orders.length !== before) saveData();
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Maple & Main server running on port ' + PORT);
});
