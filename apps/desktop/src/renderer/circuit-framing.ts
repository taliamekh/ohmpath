/** A suggested display crop in coordinates of the uncropped image (0–1). */
export type FrameRegion = {x: number; y: number; width: number; height: number};

type Tile = {x: number; y: number};
type Group = {tiles: Tile[]; left: number; top: number; right: number; bottom: number};

/**
 * Finds a compact group of two-dimensional image texture for a suggested crop.
 * It does not recognize circuits, components, or electrical evidence. Callers
 * should keep the full frame available whenever this conservative hint is null.
 * Input should be an RGBA image downsampled to at most 640 pixels on each side.
 */
export function suggestCircuitRegion(
  pixels: Uint8ClampedArray, width: number, height: number,
): FrameRegion | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 80 || height < 80 ||
      width > 640 || height > 640 || pixels.length !== width * height * 4) return null;

  const luma = new Uint8Array(width * height);
  let lit = 0;
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const value = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
    luma[i] = value;
    if (value > 32) lit++;
  }
  if (lit < luma.length * 0.12) return null;

  const size = Math.max(8, Math.min(16, Math.round(Math.min(width, height) / 28)));
  const columns = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const active = new Uint8Array(columns * rows);
  let activeCount = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < columns; tx++) {
      const x0 = tx * size, y0 = ty * size;
      const x1 = Math.min(width, x0 + size), y1 = Math.min(height, y0 + size);
      let horizontal = 0, vertical = 0, samples = 0;
      for (let y = y0 + 1; y < y1; y++) {
        for (let x = x0 + 1; x < x1; x++) {
          const p = y * width + x;
          if (Math.abs(luma[p] - luma[p - 1]) >= 25) horizontal++;
          if (Math.abs(luma[p] - luma[p - width]) >= 25) vertical++;
          samples++;
        }
      }
      // A wire edge or a single contour has little structure in its other axis.
      if (samples >= 36 && horizontal >= samples * 0.055 && vertical >= samples * 0.055 &&
          horizontal + vertical >= samples * 0.16) {
        active[ty * columns + tx] = 1;
        activeCount++;
      }
    }
  }
  if (activeCount < 8 || activeCount > active.length * 0.55) return null;

  const visited = new Uint8Array(active.length);
  const groups: Group[] = [];
  for (let index = 0; index < active.length; index++) {
    if (!active[index] || visited[index]) continue;
    const start = {x: index % columns, y: Math.floor(index / columns)};
    const group: Group = {tiles: [], left: start.x, right: start.x, top: start.y, bottom: start.y};
    const queue: Tile[] = [start];
    visited[index] = 1;
    for (let head = 0; head < queue.length; head++) {
      const tile = queue[head];
      group.tiles.push(tile);
      group.left = Math.min(group.left, tile.x); group.right = Math.max(group.right, tile.x);
      group.top = Math.min(group.top, tile.y); group.bottom = Math.max(group.bottom, tile.y);
      // Bridge small featureless gaps within a board without spanning the scene.
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = tile.x + dx, ny = tile.y + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (active[next] && !visited[next]) { visited[next] = 1; queue.push({x: nx, y: ny}); }
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.tiles.length - a.tiles.length);
  const main = groups[0];
  if (!main || main.tiles.length < 8) return null;

  let left = main.left, top = main.top, right = main.right, bottom = main.bottom;
  let selected = main.tiles.length;
  // Bring substantial nearby textured objects into the same frame (for example,
  // a breadboard next to its controller), even across a plain tabletop gap.
  for (const group of groups.slice(1)) {
    if (group.tiles.length < Math.max(5, main.tiles.length * 0.16)) continue;
    const gapX = Math.max(0, group.left - right - 1, left - group.right - 1) * size;
    const gapY = Math.max(0, group.top - bottom - 1, top - group.bottom - 1) * size;
    if (Math.hypot(gapX, gapY) > Math.min(width, height) * 0.18) continue;
    left = Math.min(left, group.left); right = Math.max(right, group.right);
    top = Math.min(top, group.top); bottom = Math.max(bottom, group.bottom);
    selected += group.tiles.length;
  }

  const x0 = left * size, y0 = top * size;
  const x1 = Math.min(width, (right + 1) * size), y1 = Math.min(height, (bottom + 1) * size);
  const boxWidth = x1 - x0, boxHeight = y1 - y0;
  if (selected * size * size < width * height * 0.008 ||
      boxWidth * boxHeight < width * height * 0.025 ||
      boxWidth > width * 0.82 && boxHeight > height * 0.7) return null;

  const marginX = Math.max(width * 0.055, boxWidth * 0.16);
  const marginY = Math.max(height * 0.045, boxHeight * 0.16);
  const cropLeft = Math.max(0, x0 - marginX), cropTop = Math.max(0, y0 - marginY);
  const cropRight = Math.min(width, x1 + marginX), cropBottom = Math.min(height, y1 + marginY);
  if ((cropRight - cropLeft) * (cropBottom - cropTop) > width * height * 0.82) return null;
  return {
    x: cropLeft / width, y: cropTop / height,
    width: (cropRight - cropLeft) / width, height: (cropBottom - cropTop) / height,
  };
}
