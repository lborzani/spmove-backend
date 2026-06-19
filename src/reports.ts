import { Router, Request, Response } from 'express';
import db from './db';
import { sendPush } from './push';

const router = Router();

const VOTE_THRESHOLD = 5;
const REPORT_TTL    = 1 * 60 * 60 * 1000;  // 1h
const RATE_LIMIT_MS = 30 * 60 * 1000;       // 1 report/linha/30min por device

const VALID_CATEGORIES = ['atraso', 'superlotacao', 'acidente', 'outro'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  atraso:       'Atraso',
  superlotacao: 'Superlotação',
  acidente:     'Acidente',
  outro:        'Ocorrência',
};

interface ReportRow {
  id: number;
  line_num: string;
  device_id: string;
  category: string;
  station: string | null;
  description: string | null;
  net_votes: number;
  promoted: number;
  created_at: number;
  expires_at: number;
  my_vote?: number | null;
}

interface SubscriberRow { token: string }

// GET /api/reports/summary — contagem de relatos promovidos por linha (home screen)
router.get('/summary', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT line_num, COUNT(*) as count
    FROM reports
    WHERE expires_at > ? AND net_votes >= -3
    GROUP BY line_num
  `).all(Date.now()) as Array<{ line_num: string; count: number }>;

  const summary: Record<string, number> = {};
  for (const row of rows) summary[row.line_num] = row.count;
  res.json({ summary });
});

// GET /api/reports?line=X&deviceId=Y — relatos ativos de uma linha
router.get('/', (req: Request, res: Response) => {
  const { line, deviceId } = req.query as { line?: string; deviceId?: string };
  if (!line) { res.status(400).json({ error: 'line required' }); return; }

  const rows = db.prepare(`
    SELECT r.id, r.line_num, r.category, r.description,
           r.net_votes, r.promoted, r.created_at, r.expires_at,
           rv.vote as my_vote
    FROM reports r
    LEFT JOIN report_votes rv ON rv.report_id = r.id AND rv.device_id = ?
    WHERE r.line_num = ? AND r.expires_at > ? AND r.net_votes >= -3
    ORDER BY r.promoted DESC, r.net_votes DESC, r.created_at DESC
  `).all(deviceId ?? '', line, Date.now()) as unknown as ReportRow[];

  res.json({ reports: rows });
});

// POST /api/reports — criar relato
router.post('/', (req: Request, res: Response) => {
  const { deviceId, lineNum, category, description, station } = req.body as {
    deviceId?: string; lineNum?: string; category?: string;
    description?: string; station?: string;
  };

  if (!deviceId || !lineNum || !category) {
    res.status(400).json({ error: 'deviceId, lineNum, category required' }); return;
  }
  if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
    res.status(400).json({ error: 'invalid category' }); return;
  }

  const now = Date.now();
  const recent = db.prepare(
    'SELECT id FROM reports WHERE device_id = ? AND line_num = ? AND created_at > ?'
  ).get(deviceId, lineNum, now - RATE_LIMIT_MS);

  if (recent) { res.status(429).json({ error: 'rate_limited' }); return; }

  const result = db.prepare(`
    INSERT INTO reports (line_num, device_id, category, station, description, net_votes, promoted, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(lineNum, deviceId, category, station ?? null, description ?? null, now, now + REPORT_TTL);

  console.log(`[reports] created id=${result.lastInsertRowid} line=${lineNum} cat=${category} station=${station ?? 'geral'}`);
  const created = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.lastInsertRowid);
  res.json({ report: created });
});

// POST /api/reports/:id/vote — votar (+1 / -1); mesmo voto = toggle off
router.post('/:id/vote', (req: Request, res: Response) => {
  const reportId = parseInt(req.params.id, 10);
  const { deviceId, vote } = req.body as { deviceId?: string; vote?: number };

  if (!deviceId || (vote !== 1 && vote !== -1)) {
    res.status(400).json({ error: 'deviceId and vote (1 or -1) required' }); return;
  }

  const report = db.prepare(
    'SELECT * FROM reports WHERE id = ? AND expires_at > ?'
  ).get(reportId, Date.now()) as unknown as ReportRow | undefined;

  if (!report) { res.status(404).json({ error: 'not found or expired' }); return; }
  if (report.device_id === deviceId) { res.status(400).json({ error: 'cannot vote on own report' }); return; }

  const existing = db.prepare(
    'SELECT vote FROM report_votes WHERE report_id = ? AND device_id = ?'
  ).get(reportId, deviceId) as { vote: number } | undefined;

  db.exec('BEGIN');
  try {
    if (existing) {
      if (existing.vote === vote) {
        db.prepare('DELETE FROM report_votes WHERE report_id = ? AND device_id = ?').run(reportId, deviceId);
      } else {
        db.prepare('UPDATE report_votes SET vote = ? WHERE report_id = ? AND device_id = ?').run(vote, reportId, deviceId);
      }
    } else {
      db.prepare('INSERT INTO report_votes (report_id, device_id, vote) VALUES (?, ?, ?)').run(reportId, deviceId, vote);
    }

    const netRow = db.prepare(
      'SELECT COALESCE(SUM(vote), 0) as net FROM report_votes WHERE report_id = ?'
    ).get(reportId) as { net: number };
    db.prepare('UPDATE reports SET net_votes = ? WHERE id = ?').run(netRow.net, reportId);

    const wasPromoted = report.promoted === 1;
    const nowPromoted = !wasPromoted && netRow.net >= VOTE_THRESHOLD;
    if (nowPromoted) {
      db.prepare('UPDATE reports SET promoted = 1 WHERE id = ?').run(reportId);
    }

    db.exec('COMMIT');

    if (nowPromoted) {
      console.log(`[reports] report ${reportId} promoted on line ${report.line_num}`);
      const subscribers = db.prepare(`
        SELECT d.token FROM line_subscriptions ls
        JOIN devices d ON d.token = ls.token
        WHERE ls.line_num = ?
      `).all(report.line_num) as unknown as SubscriberRow[];

      if (subscribers.length > 0) {
        sendPush(
          subscribers.map(s => s.token),
          `Linha ${report.line_num} · ${CATEGORY_LABELS[report.category] ?? 'Relato'}`,
          report.description ?? 'Relato de usuários confirmado na linha.',
        ).catch(err => console.error('[reports] sendPush error:', err));
      }
    }

    const updated = db.prepare(
      'SELECT net_votes, promoted FROM reports WHERE id = ?'
    ).get(reportId) as { net_votes: number; promoted: number };
    res.json({ netVotes: updated.net_votes, promoted: updated.promoted === 1 });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

export { router as reportsRouter };
