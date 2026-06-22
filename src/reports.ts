import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, gt, gte, desc, sql, count } from 'drizzle-orm';
import { db } from './db';
import { reports, reportVotes, lineSubscriptions, devices } from './schema';
import { sendPush } from './push';

const router = Router();

const VOTE_THRESHOLD = 5;
const REPORT_TTL    = 60 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 60 * 1000;

const VALID_CATEGORIES = ['atraso', 'superlotacao', 'acidente', 'outro'] as const;
type ReportCategory = typeof VALID_CATEGORIES[number];

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  atraso:       'Atraso',
  superlotacao: 'Superlotação',
  acidente:     'Acidente',
  outro:        'Ocorrência',
};

const createReportSchema = z.object({
  deviceId:    z.string().min(1).max(200),
  lineNum:     z.string().min(1).max(20),
  category:    z.enum(VALID_CATEGORIES),
  description: z.string().max(500).nullish(),
  station:     z.string().max(100).nullish(),
});

const voteSchema = z.object({
  deviceId: z.string().min(1).max(200),
  vote:     z.union([z.literal(1), z.literal(-1)]),
});

type ReportRow = { id: number; lineNum: string; category: string; station: string | null; description: string | null; netVotes: number; promoted: number; createdAt: number; expiresAt: number; myVote?: number | null };

function toSnakeCase(r: ReportRow) {
  return {
    id:          r.id,
    line_num:    r.lineNum,
    category:    r.category,
    station:     r.station,
    description: r.description,
    net_votes:   r.netVotes,
    promoted:    r.promoted,
    created_at:  r.createdAt,
    expires_at:  r.expiresAt,
    my_vote:     r.myVote ?? null,
  };
}

function getSubscribers(lineNum: string) {
  return db
    .select({ token: devices.token })
    .from(lineSubscriptions)
    .innerJoin(devices, eq(devices.token, lineSubscriptions.token))
    .where(eq(lineSubscriptions.lineNum, lineNum))
    .all();
}

// GET /api/reports/summary
router.get('/summary', (_req: Request, res: Response) => {
  const now = Date.now();
  const rows = db
    .select({ lineNum: reports.lineNum, count: count() })
    .from(reports)
    .where(and(gt(reports.expiresAt, now), gte(reports.netVotes, -3)))
    .groupBy(reports.lineNum)
    .all();

  const summary: Record<string, number> = {};
  for (const row of rows) summary[row.lineNum] = row.count;
  res.json({ summary });
});

// GET /api/reports?line=X&deviceId=Y
router.get('/', (req: Request, res: Response) => {
  const { line, deviceId } = req.query as { line?: string; deviceId?: string };
  if (!line) { res.status(400).json({ error: 'line required' }); return; }

  const now = Date.now();
  const rows = db
    .select({
      id:          reports.id,
      lineNum:     reports.lineNum,
      deviceId:    reports.deviceId,
      category:    reports.category,
      station:     reports.station,
      description: reports.description,
      netVotes:    reports.netVotes,
      promoted:    reports.promoted,
      createdAt:   reports.createdAt,
      expiresAt:   reports.expiresAt,
      myVote:      reportVotes.vote,
    })
    .from(reports)
    .leftJoin(
      reportVotes,
      and(eq(reportVotes.reportId, reports.id), eq(reportVotes.deviceId, deviceId ?? '')),
    )
    .where(and(eq(reports.lineNum, line), gt(reports.expiresAt, now), gte(reports.netVotes, -3)))
    .orderBy(desc(reports.promoted), desc(reports.netVotes), desc(reports.createdAt))
    .all();

  res.json({ reports: rows.map(toSnakeCase) });
});

// POST /api/reports
router.post('/', (req: Request, res: Response) => {
  const parsed = createReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  const { deviceId, lineNum, category, description, station } = parsed.data;

  const now = Date.now();
  const recent = db
    .select({ id: reports.id })
    .from(reports)
    .where(and(
      eq(reports.deviceId, deviceId),
      eq(reports.lineNum, lineNum),
      gt(reports.createdAt, now - RATE_LIMIT_MS),
    ))
    .get();

  if (recent) { res.status(429).json({ error: 'rate_limited' }); return; }

  const [created] = db.insert(reports).values({
    lineNum,
    deviceId,
    category,
    station:     station ?? null,
    description: description ?? null,
    netVotes:    0,
    promoted:    0,
    createdAt:   now,
    expiresAt:   now + REPORT_TTL,
  }).returning().all();

  console.log(`[reports] created id=${created.id} line=${lineNum} cat=${category}`);
  res.json({ report: toSnakeCase(created) });

  const subscribers = getSubscribers(lineNum);
  if (subscribers.length > 0) {
    const body = station
      ? `${description ?? 'Novo relato'} (${station})`
      : (description ?? 'Novo relato registrado na linha.');
    sendPush(
      subscribers.map(s => s.token),
      `Linha ${lineNum} · ${CATEGORY_LABELS[category]}`,
      body,
    ).catch(err => console.error('[reports] sendPush error:', err));
  }
});

// POST /api/reports/:id/vote
router.post('/:id/vote', (req: Request, res: Response) => {
  const reportId = parseInt(req.params.id, 10);
  if (isNaN(reportId)) { res.status(400).json({ error: 'invalid report id' }); return; }

  const parsed = voteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    return;
  }
  const { deviceId, vote } = parsed.data;

  const now = Date.now();
  const report = db.select().from(reports)
    .where(and(eq(reports.id, reportId), gt(reports.expiresAt, now)))
    .get();
  if (!report) { res.status(404).json({ error: 'not found or expired' }); return; }
  if (report.deviceId === deviceId) { res.status(400).json({ error: 'cannot vote on own report' }); return; }

  const existing = db
    .select({ vote: reportVotes.vote })
    .from(reportVotes)
    .where(and(eq(reportVotes.reportId, reportId), eq(reportVotes.deviceId, deviceId)))
    .get();

  const { netVotes, nowPromoted } = db.transaction((tx) => {
    if (existing) {
      if (existing.vote === vote) {
        tx.delete(reportVotes)
          .where(and(eq(reportVotes.reportId, reportId), eq(reportVotes.deviceId, deviceId)))
          .run();
      } else {
        tx.update(reportVotes)
          .set({ vote })
          .where(and(eq(reportVotes.reportId, reportId), eq(reportVotes.deviceId, deviceId)))
          .run();
      }
    } else {
      tx.insert(reportVotes).values({ reportId, deviceId, vote }).run();
    }

    const { net } = tx
      .select({ net: sql<number>`COALESCE(SUM(${reportVotes.vote}), 0)` })
      .from(reportVotes)
      .where(eq(reportVotes.reportId, reportId))
      .get()!;

    const shouldPromote = report.promoted !== 1 && net >= VOTE_THRESHOLD;

    const [updated] = tx.update(reports)
      .set({ netVotes: net, ...(shouldPromote ? { promoted: 1 } : {}) })
      .where(eq(reports.id, reportId))
      .returning({ netVotes: reports.netVotes, promoted: reports.promoted })
      .all();

    return { netVotes: updated.netVotes, nowPromoted: shouldPromote };
  });

  if (nowPromoted) {
    console.log(`[reports] report ${reportId} promoted on line ${report.lineNum}`);
    const subscribers = getSubscribers(report.lineNum);
    if (subscribers.length > 0) {
      sendPush(
        subscribers.map(s => s.token),
        `Linha ${report.lineNum} · ${CATEGORY_LABELS[report.category as ReportCategory] ?? 'Relato'}`,
        report.description ?? 'Relato de usuários confirmado na linha.',
      ).catch(err => console.error('[reports] sendPush error:', err));
    }
  }

  res.json({ netVotes, promoted: nowPromoted || report.promoted === 1 });
});

export { router as reportsRouter };
