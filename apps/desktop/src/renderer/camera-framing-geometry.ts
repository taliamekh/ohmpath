import type { FrameRegion } from "./circuit-framing";

export const WHOLE_FRAME: FrameRegion = { x: 0, y: 0, width: 1, height: 1 };

export function framedImageBox(width: number, height: number, sourceWidth: number, sourceHeight: number, region = WHOLE_FRAME) {
  if (![width, height, sourceWidth, sourceHeight].every(value => Number.isFinite(value) && value > 0))
    return { left: 0, top: 0, width, height };
  const scale = Math.min(width / (sourceWidth * region.width), height / (sourceHeight * region.height));
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { left: (width - w * region.width) / 2 - region.x * w,
    top: (height - h * region.height) / 2 - region.y * h, width: w, height: h };
}

export function pointInFrame(x: number, y: number, box: ReturnType<typeof framedImageBox>, region = WHOLE_FRAME) {
  const point = { x: (x - box.left) / box.width, y: (y - box.top) / box.height };
  return point.x >= region.x && point.x <= region.x + region.width
    && point.y >= region.y && point.y <= region.y + region.height ? point : null;
}
