import express, { Request, Response, NextFunction } from 'express';
import db from './db';
import { startChecker } from './checker';
import { reportsRouter } from './reports';

const app     = express();
const PORT    = process.env.PORT ?? '3000';
const API_KEY = process.env.API_KEY ?? '';

app.use(express.json({ limit: '5mb' }));

// ── Auth middleware ───────────────────────────────────────────────────────────

const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

// ── Public routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  const deviceCount = (db.prepare('SELECT COUNT(*) as c FROM devices').get() as unknown as { c: number }).c;
  const subCount    = (db.prepare('SELECT COUNT(*) as c FROM line_subscriptions').get() as unknown as { c: number }).c;
  res.json({ status: 'ok', devices: deviceCount, subscriptions: subCount });
});

// ── Protected routes ──────────────────────────────────────────────────────────

app.post('/api/register', requireApiKey, (req: Request, res: Response) => {
  const { token, lines } = req.body as { token?: string; lines?: string[] };

  if (typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'token required' });
    return;
  }
  if (!Array.isArray(lines)) {
    res.status(400).json({ error: 'lines must be an array' });
    return;
  }

  const insertDevice = db.prepare(`
    INSERT INTO devices (token, registered_at)
    VALUES (?, ?)
    ON CONFLICT(token) DO UPDATE SET registered_at = excluded.registered_at
  `);
  const deleteSubs = db.prepare('DELETE FROM line_subscriptions WHERE token = ?');
  const insertSub  = db.prepare('INSERT OR IGNORE INTO line_subscriptions (token, line_num) VALUES (?, ?)');

  db.exec('BEGIN');
  try {
    insertDevice.run(token, Date.now());
    deleteSubs.run(token);
    for (const lineNum of lines) {
      insertSub.run(token, String(lineNum));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`[register] token=${token.slice(0, 20)}... lines=${lines.join(',')}`);
  res.json({ ok: true });
});

app.use('/api/reports', requireApiKey, reportsRouter);

app.post('/api/unregister', requireApiKey, (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };

  if (typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'token required' });
    return;
  }

  db.prepare('DELETE FROM devices WHERE token = ?').run(token);
  console.log(`[unregister] token=${token.slice(0, 20)}...`);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(parseInt(PORT), () => {
  console.log(`[server] Listening on port ${PORT}`);
  startChecker();
});
