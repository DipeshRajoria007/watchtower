export function notifyDesktop(title: string, body: string): void {
  const payload = JSON.stringify({ title, body, at: new Date().toISOString() });
  process.stdout.write(`WATCHTOWER_NOTIFY::${payload}\n`);
}
