import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SlackFileAttachment {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
}

const IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function downloadSlackImages(params: {
  files: SlackFileAttachment[];
  botToken: string;
  destDir?: string;
}): Promise<string[]> {
  const { files, botToken } = params;

  const imageFiles = files.filter(f => IMAGE_MIMETYPES.has(f.mimetype));
  if (imageFiles.length === 0) return [];

  const toDownload = imageFiles.slice(0, MAX_IMAGES);

  const destDir = params.destDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-slack-images-'));
  await fs.mkdir(destDir, { recursive: true });

  const downloaded: string[] = [];

  for (const file of toDownload) {
    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) continue;

      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_IMAGE_BYTES) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) continue;

      const ext = extensionForMimetype(file.mimetype);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(destDir, `${file.id}-${safeName}${ext ? `.${ext}` : ''}`);

      await fs.writeFile(destPath, buffer);
      downloaded.push(destPath);
    } catch {
      // Skip individual file failures
    }
  }

  return downloaded;
}

function extensionForMimetype(mimetype: string): string {
  switch (mimetype) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return '';
  }
}
