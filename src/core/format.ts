export function fmtTime(sec: number, withMs = false): string {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const ss = withMs ? r.toFixed(2).padStart(5, '0') : Math.floor(r).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtDuration(sec: number): string {
  const s = Math.round(Math.max(0, sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
