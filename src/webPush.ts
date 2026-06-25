import webpush from 'web-push';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? 'mailto:admin@example.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export interface WebPushTarget {
  endpoint: string;
  p256dh:   string;
  auth:     string;
}

export async function sendWebPush(
  targets: WebPushTarget[],
  title: string,
  body: string,
): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[web-push] VAPID keys not set — skipping');
    return;
  }

  const payload = JSON.stringify({ title, body });

  await Promise.allSettled(
    targets.map(({ endpoint, p256dh, auth }) =>
      webpush
        .sendNotification({ endpoint, keys: { p256dh, auth } }, payload)
        .catch((err: { statusCode?: number }) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // subscription expired — caller should remove it
            throw err;
          }
          console.error('[web-push] send error:', err);
        }),
    ),
  );
}
