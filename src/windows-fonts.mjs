import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function installedFonts() {
  if (process.platform !== 'win32') return { families: ['Arial', 'sans-serif', 'serif', 'monospace'], fallback: true };
  const command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName PresentationCore; @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Sort-Object -Unique) | ConvertTo-Json -Compress';
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const names = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const families = (Array.isArray(names) ? names : [names]).filter(name => typeof name === 'string' && name.length && name.length <= 128);
  if (!families.length) throw new Error('Windows не вернула список шрифтов. Нажмите «Обновить».');
  return { families, fallback: false };
}
