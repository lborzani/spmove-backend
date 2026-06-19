import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import db from './db';
import { startChecker } from './checker';
import { reportsRouter } from './reports';

// ── GTFS stops (loaded once at startup) ──────────────────────────────────────

type GtfsStop = { cp: number; np: string; py: number; px: number; ed: string };
type GtfsStopsMap = Record<string, GtfsStop[]>;

let gtfsStops: GtfsStopsMap = {};
const stopRoutes: Record<string, string[]> = {};

type MetroLine = { id: string; line: string; network: string; color: string; coords: [number, number][] };
let metroLines: MetroLine[] = [];

type RouteColors = Record<string, { color: string; textColor: string }>;
let routeColors: RouteColors = {};

try {
  const staticPath = path.join(__dirname, '..', 'static', 'gtfs-stops.json');
  const dataPath   = path.join(__dirname, '..', 'data',   'gtfs-stops.json');
  const gtfsPath   = fs.existsSync(staticPath) ? staticPath : dataPath;
  const raw = fs.readFileSync(gtfsPath, 'utf8');
  gtfsStops = JSON.parse(raw) as GtfsStopsMap;
  for (const [routeKey, stops] of Object.entries(gtfsStops)) {
    for (const stop of stops) {
      const id = String(stop.cp);
      (stopRoutes[id] ??= []).push(routeKey);
    }
  }
  console.log(`[gtfs] ${Object.keys(gtfsStops).length} rotas, ${Object.keys(stopRoutes).length} paradas indexadas`);
} catch (e) {
  console.warn('[gtfs] gtfs-stops.json não encontrado — endpoints desativados');
}

try {
  const metroStaticPath = path.join(__dirname, '..', 'static', 'metro-lines.json');
  const metroDataPath   = path.join(__dirname, '..', 'data',   'metro-lines.json');
  const metroPath = fs.existsSync(metroStaticPath) ? metroStaticPath : metroDataPath;
  const raw = fs.readFileSync(metroPath, 'utf8');
  metroLines = (JSON.parse(raw) as { lines: MetroLine[] }).lines;
  console.log(`[gtfs] ${metroLines.length} linhas metro/CPTM carregadas`);
} catch {
  console.warn('[gtfs] metro-lines.json não encontrado');
}

try {
  const rcStaticPath = path.join(__dirname, '..', 'static', 'route-colors.json');
  const rcDataPath   = path.join(__dirname, '..', 'data',   'route-colors.json');
  const rcPath = fs.existsSync(rcStaticPath) ? rcStaticPath : rcDataPath;
  routeColors = JSON.parse(fs.readFileSync(rcPath, 'utf8')) as RouteColors;
  console.log(`[gtfs] ${Object.keys(routeColors).length} cores de linha carregadas`);
} catch {
  console.warn('[gtfs] route-colors.json não encontrado');
}

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

// GET /api/gtfs/stops?line=875C1-1  (public, no auth required)
app.get('/api/gtfs/stops', (req: Request, res: Response) => {
  const line = String(req.query.line ?? '').trim();
  if (!line) {
    res.status(400).json({ error: 'line param required' });
    return;
  }
  const stops = gtfsStops[line];
  if (!stops) {
    res.status(404).json({ stops: [], found: false });
    return;
  }
  res.json({ stops, found: true });
});

// GET /api/gtfs/lines-at-stop?stopId=480014949  (public)
app.get('/api/gtfs/lines-at-stop', (req: Request, res: Response) => {
  const stopId = String(req.query.stopId ?? '').trim();
  if (!stopId) { res.status(400).json({ error: 'stopId required' }); return; }
  const routes = stopRoutes[stopId] ?? [];
  res.json({ routes, found: routes.length > 0 });
});

// GET /api/gtfs/metro-stations  (public) — Metro SP + CPTM stations from GTFS
app.get('/api/gtfs/metro-stations', (_req: Request, res: Response) => {
  const METRO_COLORS: Record<string, string> = {
    '1':'#0078C0','2':'#007B40','3':'#CC0000','4':'#FFD700','5':'#9B2990','15':'#9E9E9E',
  };
  const CPTM_COLORS: Record<string, string> = {
    '7':'#B11B37','8':'#97999B','9':'#009A44','10':'#009898','11':'#F15A22','12':'#103591','13':'#00A74A',
  };
  type MetroEntry = { id: number; name: string; lat: number; lon: number; line: string; network: string; color: string };
  const seen = new Set<number>();
  const results: MetroEntry[] = [];

  for (const [routeKey, stops] of Object.entries(gtfsStops)) {
    let network = '', line = '', color = '';
    if (routeKey.startsWith('METRL') || routeKey.startsWith('METR1')) {
      network = 'Metrô SP';
      line = routeKey.replace(/^METRL?/, '').replace(/-\d$/, '');
      color = METRO_COLORS[line] ?? '#1B3FA6';
    } else if (routeKey.startsWith('CPTML')) {
      network = 'CPTM';
      line = routeKey.replace(/^CPTML0?/, '').replace(/-\d$/, '');
      color = CPTM_COLORS[line] ?? '#555';
    } else {
      continue;
    }
    for (const stop of stops) {
      if (seen.has(stop.cp)) continue;
      seen.add(stop.cp);
      results.push({ id: stop.cp, name: stop.np, lat: stop.py, lon: stop.px, line, network, color });
    }
  }

  res.json({ stations: results });
});

// GET /api/gtfs/metro-lines  (public) — real GTFS shapes for Metro SP + CPTM
app.get('/api/gtfs/metro-lines', (_req: Request, res: Response) => {
  res.json({ lines: metroLines });
});

// GET /api/gtfs/route-colors  (public) — GTFS route colors keyed by route_short_name
app.get('/api/gtfs/route-colors', (_req: Request, res: Response) => {
  res.json(routeColors);
});

// GET /api/gtfs/stops-near?lat=-23.55&lon=-46.63&radius=600  (public)
app.get('/api/gtfs/stops-near', (req: Request, res: Response) => {
  const lat = parseFloat(String(req.query.lat ?? ''));
  const lon = parseFloat(String(req.query.lon ?? ''));
  const radius = Math.min(parseFloat(String(req.query.radius ?? '600')), 2000);
  if (isNaN(lat) || isNaN(lon)) { res.status(400).json({ error: 'lat/lon required' }); return; }

  const toRad = (d: number) => (d * Math.PI) / 180;
  const hav = (lat2: number, lon2: number) => {
    const R = 6371000;
    const dLat = toRad(lat2 - lat);
    const dLon = toRad(lon2 - lon);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const seen = new Set<number>();
  const results: Array<GtfsStop & { distance: number }> = [];

  for (const [routeKey, stops] of Object.entries(gtfsStops)) {
    if (routeKey.startsWith('METRL') || routeKey.startsWith('METR1') || routeKey.startsWith('CPTML')) continue;
    for (const stop of stops) {
      if (seen.has(stop.cp)) continue;
      const d = hav(stop.py, stop.px);
      if (d <= radius) {
        seen.add(stop.cp);
        results.push({ ...stop, distance: Math.round(d) });
      }
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  res.json({ stops: results.slice(0, 150) });
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
