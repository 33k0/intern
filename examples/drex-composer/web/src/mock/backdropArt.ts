// Mock mode only: paints a soft abstract image so the backdrop cross-fade and scrim can be
// checked without the real files under /assets/backdrops/. Returned as a data URL, which the
// Backdrop component passes through untouched.

function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

export function mockBackdropUrl(hues: [number, number, number], seed: number): string {
  const w = 960;
  const h = 540;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const rand = rng(seed + hues[0]);

  ctx.fillStyle = `hsl(${hues[0]} 30% 9%)`;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i++) {
    const hue = hues[i % 3] + (rand() - 0.5) * 24;
    const x = rand() * w;
    const y = rand() * h;
    const radius = 160 + rand() * 360;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `hsla(${hue} ${45 + rand() * 30}% ${38 + rand() * 24}% / ${0.35 + rand() * 0.3})`);
    g.addColorStop(1, `hsla(${hue} 50% 30% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // A few long soft streaks so it reads as a picture rather than a gradient.
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 40; i++) {
    const x = rand() * w;
    const len = 60 + rand() * 260;
    const y = rand() * h;
    const g = ctx.createLinearGradient(x, y, x + len * 0.18, y + len);
    g.addColorStop(0, `hsla(${hues[1]} 70% 80% / 0)`);
    g.addColorStop(0.5, `hsla(${hues[1]} 70% 80% / ${0.04 + rand() * 0.08})`);
    g.addColorStop(1, `hsla(${hues[1]} 70% 80% / 0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * 0.18, y + len);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvas.toDataURL('image/jpeg', 0.82);
}
