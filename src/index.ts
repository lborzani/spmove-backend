import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { eq, count } from 'drizzle-orm';
import { db } from './db';
import { devices, lineSubscriptions, webPushSubscriptions, webPushLineSubscriptions } from './schema';
import { startChecker } from './checker';
import { reportsRouter } from './reports';
import { getCachedRaw } from './spApi';

// ── GTFS stops (loaded once at startup) ──────────────────────────────────────

type GtfsStop = { cp: number; np: string; py: number; px: number; ed: string };
type GtfsStopsMap = Record<string, GtfsStop[]>;

let gtfsStops: GtfsStopsMap = {};
const stopRoutes: Record<string, string[]> = {};

type MetroLine = { id: string; line: string; network: string; color: string; coords: [number, number][] };
let metroLines: MetroLine[] = [];

type RouteColors = Record<string, { color: string; textColor: string }>;
let routeColors: RouteColors = {};

function loadJson<T>(staticPath: string, dataPath: string): T | null {
  const p = fs.existsSync(staticPath) ? staticPath : dataPath;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}

const gtfsRaw = loadJson<GtfsStopsMap>(
  path.join(__dirname, '..', 'static', 'gtfs-stops.json'),
  path.join(__dirname, '..', 'data',   'gtfs-stops.json'),
);
if (gtfsRaw) {
  gtfsStops = gtfsRaw;
  for (const [routeKey, stops] of Object.entries(gtfsStops)) {
    for (const stop of stops) {
      const id = String(stop.cp);
      (stopRoutes[id] ??= []).push(routeKey);
    }
  }
  console.log(`[gtfs] ${Object.keys(gtfsStops).length} rotas, ${Object.keys(stopRoutes).length} paradas indexadas`);
} else {
  console.warn('[gtfs] gtfs-stops.json não encontrado — endpoints desativados');
}

const metroRaw = loadJson<{ lines: MetroLine[] }>(
  path.join(__dirname, '..', 'static', 'metro-lines.json'),
  path.join(__dirname, '..', 'data',   'metro-lines.json'),
);
if (metroRaw) {
  metroLines = metroRaw.lines;
  console.log(`[gtfs] ${metroLines.length} linhas metro/CPTM carregadas`);
} else {
  console.warn('[gtfs] metro-lines.json não encontrado');
}

const rcRaw = loadJson<RouteColors>(
  path.join(__dirname, '..', 'static', 'route-colors.json'),
  path.join(__dirname, '..', 'data',   'route-colors.json'),
);
if (rcRaw) {
  routeColors = rcRaw;
  console.log(`[gtfs] ${Object.keys(routeColors).length} cores de linha carregadas`);
} else {
  console.warn('[gtfs] route-colors.json não encontrado');
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app     = express();
const PORT    = process.env.PORT ?? '3000';
const API_KEY = process.env.API_KEY ?? '';

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:8081')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));

// ── Auth middleware ───────────────────────────────────────────────────────────

const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
  if (!API_KEY) return next();
  const key = String(req.headers['x-api-key'] ?? '');
  try {
    if (key.length !== API_KEY.length || !timingSafeEqual(Buffer.from(key), Buffer.from(API_KEY))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

// ── Public routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  const [{ count: deviceCount }] = db.select({ count: count() }).from(devices).all();
  const [{ count: subCount }]    = db.select({ count: count() }).from(lineSubscriptions).all();
  res.json({ status: 'ok', devices: deviceCount, subscriptions: subCount });
});

app.get('/api/metro/status/', (_req: Request, res: Response) => {
  const cached = getCachedRaw();
  if (!cached) { res.status(503).json({ error: 'status not yet available' }); return; }
  res.json(cached.data);
});

const CCM_BASE    = 'https://ccm.artesp.sp.gov.br/metroferroviario/api';
const ccmHeaders  = () => ({ Accept: 'application/json', Authorization: `Api-Key ${process.env.CCM_API_KEY}` });

const OCORRENCIAS_TTL = 5 * 60 * 1000; // 5 min
const ocorrenciasCache = new Map<string, { data: unknown; cachedAt: number }>();

app.get('/api/metro/ocorrencias/', async (req: Request, res: Response) => {
  const dataInicio = String(req.query.data_inicio ?? '').trim();
  const dataFim    = String(req.query.data_fim    ?? '').trim();
  if (!dataInicio || !dataFim) {
    res.status(400).json({ error: 'data_inicio and data_fim required' });
    return;
  }

  const cacheKey = `${dataInicio}_${dataFim}`;
  const cached = ocorrenciasCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < OCORRENCIAS_TTL) {
    res.json(cached.data);
    return;
  }

  try {
    const upstream = await fetch(
      `${CCM_BASE}/ocorrencias/?data_inicio=${dataInicio}&data_fim=${dataFim}`,
      { headers: ccmHeaders(), signal: AbortSignal.timeout(15_000) },
    );
    if (upstream.status === 429 || upstream.status === 403) {
      const body = await upstream.text().catch(() => '(unreadable)');
      console.warn(`[proxy] /ocorrencias/ rate limited (${upstream.status}):`, body);
      if (cached) { res.json(cached.data); return; }
      res.status(429).json({ error: 'rate limited' }); return;
    }
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '(unreadable)');
      console.error(`[proxy] /ocorrencias/ upstream ${upstream.status}:`, body);
      res.status(upstream.status).json({ error: 'upstream error' }); return;
    }
    const data = await upstream.json();
    ocorrenciasCache.set(cacheKey, { data, cachedAt: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[proxy] /ocorrencias/ error:', err);
    if (cached) { res.json(cached.data); return; }
    res.status(502).json({ error: 'upstream unavailable' });
  }
});

app.get('/api/gtfs/stops', (req: Request, res: Response) => {
  const line = String(req.query.line ?? '').trim();
  if (!line) { res.status(400).json({ error: 'line param required' }); return; }
  const stops = gtfsStops[line];
  if (!stops) { res.status(404).json({ stops: [], found: false }); return; }
  res.json({ stops, found: true });
});

app.get('/api/gtfs/lines-at-stop', (req: Request, res: Response) => {
  const stopId = String(req.query.stopId ?? '').trim();
  if (!stopId) { res.status(400).json({ error: 'stopId required' }); return; }
  const routes = stopRoutes[stopId] ?? [];
  res.json({ routes, found: routes.length > 0 });
});

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
      line  = routeKey.replace(/^METRL?/, '').replace(/-\d$/, '');
      color = METRO_COLORS[line] ?? '#1B3FA6';
    } else if (routeKey.startsWith('CPTML')) {
      network = 'CPTM';
      line  = routeKey.replace(/^CPTML0?/, '').replace(/-\d$/, '');
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

app.get('/api/gtfs/metro-lines', (_req: Request, res: Response) => {
  res.json({ lines: metroLines });
});

app.get('/api/gtfs/route-colors', (_req: Request, res: Response) => {
  res.json(routeColors);
});

app.get('/api/gtfs/stops-near', (req: Request, res: Response) => {
  const lat    = parseFloat(String(req.query.lat ?? ''));
  const lon    = parseFloat(String(req.query.lon ?? ''));
  const radius = Math.min(parseFloat(String(req.query.radius ?? '600')), 2000);
  if (isNaN(lat) || isNaN(lon)) { res.status(400).json({ error: 'lat/lon required' }); return; }

  const toRad = (d: number) => (d * Math.PI) / 180;
  const hav = (lat2: number, lon2: number) => {
    const R = 6371000, dLat = toRad(lat2 - lat), dLon = toRad(lon2 - lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const seen = new Set<number>();
  const results: Array<GtfsStop & { distance: number }> = [];

  for (const [routeKey, stops] of Object.entries(gtfsStops)) {
    if (routeKey.startsWith('METRL') || routeKey.startsWith('METR1') || routeKey.startsWith('CPTML')) continue;
    for (const stop of stops) {
      if (seen.has(stop.cp)) continue;
      const d = hav(stop.py, stop.px);
      if (d <= radius) { seen.add(stop.cp); results.push({ ...stop, distance: Math.round(d) }); }
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  res.json({ stops: results.slice(0, 150) });
});

// ── Web Push routes ───────────────────────────────────────────────────────────

const webPushSubscribeSchema = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
  lines: z.array(z.string().min(1).max(20)).max(50),
});

app.post('/api/web-push/subscribe', requireApiKey, (req: Request, res: Response) => {
  const parsed = webPushSubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  const { endpoint, keys, lines } = parsed.data;

  db.transaction((tx) => {
    tx.insert(webPushSubscriptions)
      .values({ endpoint, p256dh: keys.p256dh, auth: keys.auth, registeredAt: Date.now() })
      .onConflictDoUpdate({ target: webPushSubscriptions.endpoint, set: { p256dh: keys.p256dh, auth: keys.auth, registeredAt: Date.now() } })
      .run();
    tx.delete(webPushLineSubscriptions).where(eq(webPushLineSubscriptions.endpoint, endpoint)).run();
    for (const lineNum of lines) {
      tx.insert(webPushLineSubscriptions).values({ endpoint, lineNum }).onConflictDoNothing().run();
    }
  });

  console.log(`[web-push] subscribe endpoint=${endpoint.slice(0, 40)}... lines=${lines.join(',')}`);
  res.json({ ok: true });
});

const webPushUnsubscribeSchema = z.object({
  endpoint: z.url(),
});

app.post('/api/web-push/unsubscribe', requireApiKey, (req: Request, res: Response) => {
  const parsed = webPushUnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, parsed.data.endpoint)).run();
  console.log(`[web-push] unsubscribe endpoint=${parsed.data.endpoint.slice(0, 40)}...`);
  res.json({ ok: true });
});

// ── Protected routes ──────────────────────────────────────────────────────────

const registerSchema = z.object({
  token: z.string().min(1).max(500),
  lines: z.array(z.string().min(1).max(20)).max(50),
});

app.post('/api/register', requireApiKey, (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  const { token, lines } = parsed.data;

  db.transaction((tx) => {
    tx.insert(devices)
      .values({ token, registeredAt: Date.now() })
      .onConflictDoUpdate({ target: devices.token, set: { registeredAt: Date.now() } })
      .run();
    tx.delete(lineSubscriptions).where(eq(lineSubscriptions.token, token)).run();
    for (const lineNum of lines) {
      tx.insert(lineSubscriptions).values({ token, lineNum }).onConflictDoNothing().run();
    }
  });

  console.log(`[register] token=${token.slice(0, 20)}... lines=${lines.join(',')}`);
  res.json({ ok: true });
});

app.use('/api/reports', requireApiKey, reportsRouter);

const unregisterSchema = z.object({
  token: z.string().min(1).max(500),
});

app.post('/api/unregister', requireApiKey, (req: Request, res: Response) => {
  const parsed = unregisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  db.delete(devices).where(eq(devices.token, parsed.data.token)).run();
  console.log(`[unregister] token=${parsed.data.token.slice(0, 20)}...`);
  res.json({ ok: true });
});

// ── Centralized error handler ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(parseInt(PORT), () => {
  console.log(`[server] Listening on port ${PORT}`);
  startChecker();
});
