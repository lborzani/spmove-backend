import Expo, { ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function sendPush(tokens: string[], title: string, body: string): Promise<void> {
  const messages: ExpoPushMessage[] = tokens
    .filter(t => Expo.isExpoPushToken(t))
    .map(t => ({ to: t, title, body, sound: 'default' as const }));

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === 'error') {
          console.error('[push] receipt error:', receipt.message, receipt.details);
        }
      }
    } catch (err) {
      console.error('[push] chunk error:', err);
    }
  }
}
