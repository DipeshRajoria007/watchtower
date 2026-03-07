export type DesktopNotificationTone = "success" | "failure";

export function notifyDesktop(
  title: string,
  body: string,
  tone: DesktopNotificationTone = "failure",
): void {
  const payload = JSON.stringify({
    title,
    body,
    tone,
    at: new Date().toISOString(),
  });
  process.stdout.write(`WATCHTOWER_NOTIFY::${payload}\n`);
}
