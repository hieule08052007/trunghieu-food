const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pg = null;
try { pg = require('pg'); } catch (_) {}

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');
const ADMIN_FILE = path.join(ROOT, 'admin.html');
const MAX_BODY = 100 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

let pool = null;
let dbReady = false;
let fileWriteQueue = Promise.resolve();
const rateBuckets = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, value] of rateBuckets) {
    if (value.start < cutoff) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function safeText(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v); }
function validTime(v) { return /^\d{2}:\d{2}$/.test(v); }
function validEmail(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_BODY) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Dữ liệu gửi lên quá lớn.'));
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('JSON không hợp lệ.')); }
    });
    req.on('error', reject);
  });
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function makeSession() {
  const payload = `${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}
function isAdmin(req) {
  const token = cookie(req, 'th_admin');
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  const created = Number(payload.split(':')[0]);
  return Number.isFinite(created) && Date.now() - created < SESSION_TTL_MS;
}
function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    send(res, 401, { message: 'Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập admin.' });
    return false;
  }
  return true;
}

function readBookingsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeBookingsFile(data) {
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}
function queuedFileWrite(fn) {
  fileWriteQueue = fileWriteQueue.then(fn, fn);
  return fileWriteQueue;
}

async function initDatabase() {
  if (!DATABASE_URL) return;
  if (!pg) throw new Error('Thiếu package pg. Hãy chạy npm install.');
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      guests INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 50),
      date DATE NOT NULL,
      time TIME NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','completed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings(date);
    CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status);
    CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings(created_at DESC);
  `);
  dbReady = true;
  console.log('Database: PostgreSQL connected');
}

async function getBookings() {
  if (dbReady) {
    const { rows } = await pool.query(`
      SELECT id, name, phone, guests, TO_CHAR(date,'YYYY-MM-DD') AS date,
             TO_CHAR(time,'HH24:MI') AS time, email, status,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM bookings ORDER BY created_at DESC
    `);
    return rows;
  }
  return readBookingsFile();
}

async function createBooking(b) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  if (dbReady) {
    await pool.query(`
      INSERT INTO bookings (id,name,phone,guests,date,time,email,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
    `, [id,b.name,b.phone,b.guests,b.date,b.time,b.email || null,createdAt]);
    return id;
  }
  await queuedFileWrite(async () => {
    const bookings = readBookingsFile();
    bookings.unshift({ id, ...b, status: 'pending', createdAt });
    writeBookingsFile(bookings);
  });
  return id;
}

async function updateBooking(id, status) {
  const updatedAt = new Date().toISOString();
  if (dbReady) {
    const { rows } = await pool.query(`
      UPDATE bookings SET status=$1, updated_at=$2 WHERE id=$3
      RETURNING id,name,phone,guests,TO_CHAR(date,'YYYY-MM-DD') AS date,
                TO_CHAR(time,'HH24:MI') AS time,email,status,
                created_at AS "createdAt",updated_at AS "updatedAt"
    `, [status,updatedAt,id]);
    return rows[0] || null;
  }
  let found = null;
  await queuedFileWrite(async () => {
    const bookings = readBookingsFile();
    const item = bookings.find(x => x.id === id);
    if (!item) return;
    item.status = status;
    item.updatedAt = updatedAt;
    found = item;
    writeBookingsFile(bookings);
  });
  return found;
}

async function deleteBooking(id) {
  if (dbReady) {
    const result = await pool.query('DELETE FROM bookings WHERE id=$1', [id]);
    return result.rowCount > 0;
  }
  let deleted = false;
  await queuedFileWrite(async () => {
    const bookings = readBookingsFile();
    const next = bookings.filter(x => x.id !== id);
    deleted = next.length !== bookings.length;
    if (deleted) writeBookingsFile(next);
  });
  return deleted;
}

function publicIndex(res) {
  const file = path.join(ROOT, 'index1.html');
  if (!fs.existsSync(file)) return send(res,404,'Not found','text/plain; charset=utf-8');
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(file).pipe(res);
}
function serveStatic(res, pathname) {
  let file;
  try { file = path.join(ROOT, decodeURIComponent(pathname)); } catch { return send(res,400,'Bad request','text/plain; charset=utf-8'); }
  const normalizedRoot = path.resolve(ROOT) + path.sep;
  const normalizedFile = path.resolve(file);
  if (!normalizedFile.startsWith(normalizedRoot)) return send(res,403,'Forbidden','text/plain; charset=utf-8');
  if (!fs.existsSync(normalizedFile) || !fs.statSync(normalizedFile).isFile()) return send(res,404,'Not found','text/plain; charset=utf-8');
  const ext = path.extname(normalizedFile).toLowerCase();
  const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
  res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(normalizedFile).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = clientIp(req);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res,200,{ok:true,database:dbReady?'postgresql':'local-file'});
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) return send(res,429,{message:'Quá nhiều lần đăng nhập. Vui lòng thử lại sau 15 phút.'});
      const body = await getBody(req);
      if (String(body.password || '') !== ADMIN_PASSWORD) return send(res,401,{message:'Mật khẩu admin không đúng.'});
      const token = makeSession();
      const secure = NODE_ENV === 'production' ? '; Secure' : '';
      return send(res,200,{ok:true},'application/json; charset=utf-8',{
        'Set-Cookie': `th_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS/1000}${secure}`
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      return send(res,200,{ok:true},'application/json; charset=utf-8',{'Set-Cookie':'th_admin=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'});
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/me') return send(res,200,{loggedIn:isAdmin(req)});

    if (req.method === 'POST' && url.pathname === '/api/bookings') {
      if (!rateLimit(`booking:${ip}`, 20, 15 * 60 * 1000)) return send(res,429,{message:'Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.'});
      const body = await getBody(req);
      const name = safeText(body.name,100);
      const phone = safeText(body.phone,30);
      const guests = Number(body.guests);
      const date = safeText(body.date,10);
      const time = safeText(body.time,5);
      const email = safeText(body.email,150);
      if (!name || !phone || !Number.isInteger(guests) || guests < 1 || guests > 50 || !validDate(date) || !validTime(time) || !validEmail(email)) {
        return send(res,400,{message:'Vui lòng nhập đầy đủ và đúng thông tin đặt bàn.'});
      }
      const bookingId = await createBooking({name,phone,guests,date,time,email});
      return send(res,201,{ok:true,bookingId});
    }

    if (req.method === 'GET' && url.pathname === '/api/bookings') {
      if (!requireAdmin(req,res)) return;
      return send(res,200,await getBookings());
    }

    const match = url.pathname.match(/^\/api\/bookings\/([^/]+)$/);
    if (match && req.method === 'PATCH') {
      if (!requireAdmin(req,res)) return;
      const body = await getBody(req);
      const allowed = ['pending','confirmed','rejected','completed'];
      if (!allowed.includes(body.status)) return send(res,400,{message:'Trạng thái không hợp lệ.'});
      const item = await updateBooking(match[1],body.status);
      if (!item) return send(res,404,{message:'Không tìm thấy đơn đặt bàn.'});
      return send(res,200,{ok:true,item});
    }

    if (match && req.method === 'DELETE') {
      if (!requireAdmin(req,res)) return;
      const deleted = await deleteBooking(match[1]);
      if (!deleted) return send(res,404,{message:'Không tìm thấy đơn đặt bàn.'});
      return send(res,200,{ok:true});
    }

    if (req.method === 'GET') {
      if (url.pathname === '/') return publicIndex(res);
      if (url.pathname === '/admin') {
        if (!fs.existsSync(ADMIN_FILE)) return send(res,404,'Not found','text/plain; charset=utf-8');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});
        return fs.createReadStream(ADMIN_FILE).pipe(res);
      }
      return serveStatic(res,url.pathname);
    }
    return send(res,405,{message:'Method not allowed'});
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res,500,{message:'Lỗi máy chủ. Vui lòng thử lại.'});
    else res.destroy();
  }
});

async function start() {
  try {
    if (DATABASE_URL) await initDatabase();
    else console.log('Database: local JSON fallback (chỉ dùng phát triển/test)');
    server.listen(PORT, '0.0.0.0', () => console.log(`TRUNGHIEU FOOD running on port ${PORT}`));
  } catch (err) {
    console.error('Không thể khởi động server:', err);
    process.exit(1);
  }
}

async function shutdown() {
  server.close(async () => {
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
start();
