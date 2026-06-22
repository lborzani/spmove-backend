import cron from 'node-cron';
import { eq, lte } from 'drizzle-orm';
import { db } from './db';
import { prevStatus, lineSubscriptions, devices, reports } from './schema';
import { fetchStatus, type StatusType, RateLimitError } from './spApi';
import { sendPush } from './push';

const STATUS_LABELS: Record<StatusType, string> = {
  normal:  'Operação Normal',
  lento:   'Velocidade Reduzida',
  atencao: 'Operação Parcial',
  parado:  'Linha Parada',
};

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

  const prevRows = db.select().from(prevStatus).all();
  const prevMap  = new Map(prevRows.map(r => [r.lineNum, r.status as StatusType]));

  for (const line of lines) {
    const prev = prevMap.get(line.num);

    if (prev !== undefined && prev !== line.status) {
      console.log(`[checker] Linha ${line.num} ${prev} → ${line.status}`);

      const subscribers = db
        .select({ token: devices.token })
        .from(lineSubscriptions)
        .innerJoin(devices, eq(devices.token, lineSubscriptions.token))
        .where(eq(lineSubscriptions.lineNum, line.num))
        .all();

      if (subscribers.length > 0) {
        sendPush(
          subscribers.map(s => s.token),
          `Linha ${line.num} · ${line.name}`,
          line.note || STATUS_LABELS[line.status],
        ).catch(err => console.error('[checker] sendPush error:', err));
      }
    }

    db.insert(prevStatus)
      .values({ lineNum: line.num, status: line.status, note: line.note || null, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: prevStatus.lineNum,
        set: { status: line.status, note: line.note || null, updatedAt: Date.now() },
      })
      .run();
  }

  db.delete(reports).where(lte(reports.expiresAt, Date.now())).run();
}

export function startChecker(): void {
  checkStatus().catch(err => console.error('[checker] initial check error:', err));
  cron.schedule('*/5 * * * *', () => {
    checkStatus().catch(err => console.error('[checker] cron error:', err));
  });
  console.log('[checker] Started — polling every 5 minutes (12 req/hour limit)');
}
