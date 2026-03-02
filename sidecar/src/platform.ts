export function assertMacOS(platform: string = process.platform): void {
  if (platform !== 'darwin') {
    throw new Error('watchtower sidecar is macOS-only');
  }
}
