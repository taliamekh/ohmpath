import type { FrameRegion } from "./circuit-framing";

/** Estimate an in-plane board tilt from strong straight edges. Null means keep the raw view. */
export function estimateOverheadTilt(pixels: Uint8ClampedArray, width: number, height: number, region?: FrameRegion): number | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100
      || width > 640 || height > 640 || pixels.length !== width * height * 4) return null;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4)
    gray[i] = Math.round((pixels[p] * 77 + pixels[p + 1] * 150 + pixels[p + 2] * 29) / 256);
  const smooth = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    smooth[i] = Math.round((gray[i - width - 1] + 2 * gray[i - width] + gray[i - width + 1]
      + 2 * gray[i - 1] + 4 * gray[i] + 2 * gray[i + 1]
      + gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1]) / 16);
  }
  const left = Math.max(2, Math.floor((region?.x ?? .03) * width));
  const right = Math.min(width - 2, Math.ceil(((region?.x ?? 0) + (region?.width ?? .94)) * width));
  const top = Math.max(2, Math.floor((region?.y ?? .03) * height));
  const bottom = Math.min(height - 2, Math.ceil(((region?.y ?? 0) + (region?.height ?? .94)) * height));
  if (right - left < 70 || bottom - top < 70) return null;
  const edges: Array<{ x: number; y: number; weight: number }> = [];
  for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
    const i = y * width + x;
    const gx = (smooth[i + 1 - width] + 2 * smooth[i + 1] + smooth[i + 1 + width])
      - (smooth[i - 1 - width] + 2 * smooth[i - 1] + smooth[i - 1 + width]);
    const gy = (smooth[i - 1 + width] + 2 * smooth[i + width] + smooth[i + 1 + width])
      - (smooth[i - 1 - width] + 2 * smooth[i - width] + smooth[i + 1 - width]);
    const magnitude = Math.hypot(gx, gy);
    if (magnitude < 110) continue;
    let angle = Math.atan2(gy, gx) * 180 / Math.PI + 90;
    while (angle >= 45) angle -= 90;
    while (angle < -45) angle += 90;
    if (Math.abs(angle) > 30) continue;
    edges.push({ x: x - width / 2, y: y - height / 2, weight: Math.min(magnitude, 650) });
  }
  if (edges.length < 80) return null;
  const centerX = edges.reduce((sum, edge) => sum + edge.x, 0) / edges.length;
  const centerY = edges.reduce((sum, edge) => sum + edge.y, 0) / edges.length;
  let spreadX = 0, spreadY = 0, cross = 0;
  for (const edge of edges) {
    const x = edge.x - centerX, y = edge.y - centerY;
    spreadX += x * x; spreadY += y * y; cross += x * y;
  }
  const spread = spreadX + spreadY;
  const axisDifference = Math.hypot(spreadX - spreadY, 2 * cross);
  if (spread <= 0 || (spread - axisDifference) / (spread + axisDifference) < .08) return null;
  const span = Math.ceil(Math.hypot(width, height) / 4) + 3;
  let bestAngle = 0, bestScore = 0, scoreTotal = 0;
  for (let angle = -28; angle <= 28; angle++) {
    const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const horizontal = new Float64Array(span * 2 + 1), vertical = new Float64Array(span * 2 + 1);
    for (const edge of edges) {
      horizontal[Math.round((edge.y * cos - edge.x * sin) / 2) + span] += edge.weight;
      vertical[Math.round((edge.x * cos + edge.y * sin) / 2) + span] += edge.weight;
    }
    let score = 0;
    for (let i = 0; i < horizontal.length; i++) score += horizontal[i] ** 2 + vertical[i] ** 2;
    scoreTotal += score;
    if (score > bestScore) { bestScore = score; bestAngle = angle; }
  }
  if (bestScore < scoreTotal / 57 * 1.08) return null;
  return Math.abs(bestAngle) >= 2 ? bestAngle : 0;
}
