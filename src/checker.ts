import cron from 'node-cron';
import db from './db';
import { fetchStatus, type StatusType, RateLimitError } from './spApi';
import { sendPush } from './push';

interface PrevStatusRow {
  line_num:   string;
  status:     string;
  note:       string | null;
  updated_at: number;
}

interface SubscriberRow {
  token: string;
}

const STATUS_LABELS: Record<StatusType, string> = {
  normal:  'Operação Normal',
  lento:   'Velocidade Reduzida',
  atencao: 'Operação Parcial',
  parado:  'Linha Parada',
};

const stmtPrevAll  = db.prepare('SELECT * FROM prev_status');
const stmtUpsert   = db.prepare(`
  INSERT INTO prev_status (line_num, status, note, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(line_num) DO UPDATE SET
    status     = excluded.status,
    note       = excluded.note,
    updated_at = excluded.updated_at
`);
const stmtTokens = db.prepare(`
  SELECT d.token
  FROM line_subscriptions ls
  JOIN devices d ON d.token = ls.token
  WHERE ls.line_num = ?
`);

async function checkStatus(): Promise<void> {
  let lines;
  try {
    lines = await fetchStatus();
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn('[checker] rate limited by ARTESP API — skipping cycle');
      return;
    }
    console.error('[checker] fetch error:', err);
    return;
  }

  const prevRows  = stmtPrevAll.all() as unknown as PrevStatusRow[];
  const prevMap   = new Map(prevRows.map(r => [r.line_num, r.status as StatusType]));

  for (const line of lines) {
    const prev = prevMap.get(line.num);

    if (prev !== undefined && prev !== line.status) {
      console.log(`[checker] Linha ${line.num} ${prev} → ${line.status}`);

      const subscribers = stmtTokens.all(line.num) as unknown as SubscriberRow[];
      if (subscribers.length > 0) {
        const tokens = subscribers.map(s => s.token);
        const title  = `Linha ${line.num} · ${line.name}`;
        const body   = line.note || STATUS_LABELS[line.status];
        sendPush(tokens, title, body).catch(err =>
          console.error('[checker] sendPush error:', err)
        );
      }
    }

    stmtUpsert.run(line.num, line.status, line.note, Date.now());
  }

  db.prepare('DELETE FROM reports WHERE expires_at <= ?').run(Date.now());
}

export function startChecker(): void {
  checkStatus().catch(err => console.error('[checker] initial check error:', err));

  cron.schedule('*/5 * * * *', () => {
    checkStatus().catch(err => console.error('[checker] cron error:', err));
  });

  console.log('[checker] Started — polling every 5 minutes (12 req/hour limit)');
}
