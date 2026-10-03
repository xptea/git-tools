export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatBytes(value: number): string {
  if (!value) return '0 B';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function safeArchivePath(path: string): string {
  const segments = path.split('/');
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[a-z]:/i.test(path) ||
    segments.some((s) => !s || s === '..' || s === '.')
  ) {
    throw new Error('This repository contains a path that cannot be safely added to a ZIP.');
  }
  return path;
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        signal?.throwIfAborted();
        const index = next++;
        result[index] = await operation(items[index], index);
      }
    }),
  );
  return result;
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
