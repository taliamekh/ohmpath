import { useEffect, useRef, useState } from "react";

export type CharacterRigProps = {
  src: string;
  frame?: { columns: number; rows: number; column: number; row: number; offsetX?: number };
  activity: "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";
  expression?: string;
  reducedMotion?: boolean;
  aspectRatio?: number;
  mouth?: { x: number; y: number };
};

type Point = { x: number; y: number };
type LoadedImage = { src: string; image: HTMLImageElement };

// Mesh knots follow the supplied full-body artwork: ears near 12%, cape near
// 35%, sleeves below 45%, hem above 80%. The face, core and feet remain fixed.
const X_KNOTS = [0, .12, .18, .24, .30, .36, .42, .5, .58, .64, .70, .76, .82, .88, 1];
const Y_KNOTS = [0, .06, .10, .13, .16, .20, .28, .36, .44, .52, .60, .68, .76, .82, .88, .94, 1];
const FRAME_INTERVAL_MS = 1000 / 30;

function smooth(a: number, b: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function band(value: number, a: number, b: number, c: number, d: number): number {
  return smooth(a, b, value) * (1 - smooth(c, d, value));
}

function warp(x: number, y: number, width: number, height: number,
              seconds: number, amount: number, earAmount: number): Point {
  if (!amount) return { x, y };
  const u = x / width;
  const v = y / height;
  const left = 1 - smooth(.28, .42, u);
  const right = smooth(.58, .72, u);
  const outer = left + right;
  const direction = right - left;
  const arm = outer * band(v, .39, .48, .76, .89);
  const cape = outer * band(v, .26, .34, .50, .60);
  const hem = outer * band(v, .72, .79, .91, 1);
  const earLeft = band(u, .16, .20, .30, .34) * band(v, .08, .11, .17, .21);
  const earRight = band(u, .66, .70, .80, .84) * band(v, .08, .11, .17, .21);
  const armWave = Math.sin(seconds * 1.05);
  const clothWave = Math.sin(seconds * .82 - .45);
  const earPerk = (.5 + .5 * Math.sin(seconds * .92)) * earAmount;
  // Opposite small rotations around each inner ear root keep the head still.
  const leftAngle = .027 * earPerk * earLeft;
  const rightAngle = -.027 * earPerk * earRight;
  const earDx = -leftAngle * (y - .18 * height) - rightAngle * (y - .18 * height);
  const earDy = leftAngle * (x - .33 * width) + rightAngle * (x - .67 * width);
  return {
    x: x + amount * width * (
      .012 * arm * armWave * direction +
      .006 * cape * clothWave * direction +
      .009 * hem * Math.sin(seconds * .76 - .8) * direction
    ) + amount * earDx,
    y: y + amount * height * (
      .0035 * arm * Math.sin(seconds * 1.05 - .55) +
      .002 * hem * Math.sin(seconds * .76 - 1.2)
    ) + amount * earDy,
  };
}

function drawTriangle(ctx: CanvasRenderingContext2D, texture: HTMLCanvasElement,
                      source: [Point, Point, Point], target: [Point, Point, Point]): void {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = target;
  const determinant = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (!determinant) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / determinant;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / determinant;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / determinant;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / determinant;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  const center = { x: (d0.x + d1.x + d2.x) / 3, y: (d0.y + d1.y + d2.y) / 3 };
  ctx.save();
  ctx.beginPath();
  // A small shared-edge overlap avoids transparent seams between triangles.
  for (let index = 0; index < 3; index += 1) {
    const point = target[index];
    const distance = Math.hypot(point.x - center.x, point.y - center.y) || 1;
    const scale = 1 + .55 / distance;
    const px = center.x + (point.x - center.x) * scale;
    const py = center.y + (point.y - center.y) * scale;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  const minX = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 2);
  const minY = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 2);
  const maxX = Math.min(texture.width, Math.ceil(Math.max(s0.x, s1.x, s2.x)) + 2);
  const maxY = Math.min(texture.height, Math.ceil(Math.max(s0.y, s1.y, s2.y)) + 2);
  ctx.drawImage(texture, minX, minY, maxX - minX, maxY - minY,
                minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

function frameSpec(frame?: CharacterRigProps["frame"]) {
  const columns = frame && Number.isInteger(frame.columns) && frame.columns > 0
    ? Math.min(frame.columns, 16) : 1;
  const rows = frame && Number.isInteger(frame.rows) && frame.rows > 0
    ? Math.min(frame.rows, 16) : 1;
  const column = frame && Number.isInteger(frame.column)
    ? Math.max(0, Math.min(columns - 1, frame.column)) : 0;
  const row = frame && Number.isInteger(frame.row)
    ? Math.max(0, Math.min(rows - 1, frame.row)) : 0;
  const offsetX = frame && typeof frame.offsetX === "number" && Number.isFinite(frame.offsetX)
    ? Math.max(-.15, Math.min(.15, frame.offsetX)) : 0;
  return { columns, rows, column, row, offsetX };
}

function frameRect(image: HTMLImageElement, spec: ReturnType<typeof frameSpec>) {
  const width = image.naturalWidth / spec.columns;
  const height = image.naturalHeight / spec.rows;
  const x = Math.max(0, Math.min(image.naturalWidth - width,
                                 (spec.column + spec.offsetX) * width));
  return { x, y: spec.row * height, width, height };
}

function motionAmount(activity: CharacterRigProps["activity"], reducedMotion: boolean): number {
  if (reducedMotion || activity === "paused") return 0;
  if (activity === "error") return .3;
  if (activity === "listening") return .65;
  if (activity === "thinking") return .8;
  if (activity === "speaking") return .7;
  return 1;
}

function unmoved(source: Point, target: Point, left: number, top: number): boolean {
  return Math.abs(target.x - source.x - left) < .001
    && Math.abs(target.y - source.y - top) < .001;
}

/** Deforms selected outer regions of one full-body source image in place. */
export default function CharacterRig({ src, frame, activity, expression,
                                       reducedMotion = false, aspectRatio = .5,
                                       mouth }: CharacterRigProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [paintedKey, setPaintedKey] = useState<string | null>(null);
  const [fallbackSize, setFallbackSize] = useState({ width: 0, height: 0 });
  const paintedKeyRef = useRef<string | null>(null);
  const spec = frameSpec(frame);
  const selectedKey = loaded ? `${loaded.src}|${spec.columns}:${spec.rows}:${spec.column}:${spec.row}:${spec.offsetX}` : null;
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0
    ? Math.max(.25, Math.min(2, aspectRatio)) : .5;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(0, Math.min(bounds.width, bounds.height * safeRatio));
      const height = width / safeRatio;
      setFallbackSize(previous => Math.abs(previous.width - width) < .5
        && Math.abs(previous.height - height) < .5 ? previous : { width, height });
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(canvas);
    update();
    return () => observer?.disconnect();
  }, [safeRatio]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let stale = false;
    let displayed = false;
    if (!src) {
      setLoaded(null);
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!stale) {
        displayed = Boolean(image.naturalWidth && image.naturalHeight);
        setLoaded(displayed ? { src, image } : null);
      }
    };
    image.onerror = () => { if (!stale) setLoaded(null); };
    image.src = src;
    return () => {
      stale = true;
      image.onload = null;
      image.onerror = null;
      if (!displayed) image.src = "";
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      paintedKeyRef.current = null;
      setPaintedKey(null);
      return; // The source-matched CSS frame remains visible.
    }
    const image = loaded?.image;
    const rect = image ? frameRect(image, spec) : null;
    const amount = motionAmount(activity, reducedMotion || prefersReducedMotion);
    const earAmount = activity === "listening" ? 1.5 : 1;
    let texture: HTMLCanvasElement | null = null;
    let stageWidth = 0;
    let stageHeight = 0;
    let raf = 0;
    let lastFrame = -Infinity;
    let visible = true;
    let ticking = false;

    function resize() {
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const density = Math.min(window.devicePixelRatio || 1, 2,
                               Math.sqrt(2_000_000 / (width * height)));
      const pixelWidth = Math.max(1, Math.round(width * density));
      const pixelHeight = Math.max(1, Math.round(height * density));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        texture = null;
      }
    }

    function draw(milliseconds: number) {
      if (!canvas || !ctx) return;
      resize();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!image || !rect) {
        if (paintedKeyRef.current !== null) {
          paintedKeyRef.current = null;
          setPaintedKey(null);
        }
        return;
      }
      const width = Math.floor(Math.min(canvas.width, canvas.height * safeRatio));
      const height = Math.floor(width / safeRatio);
      if (!width || !height) return;
      if (!texture || stageWidth !== width || stageHeight !== height) {
        texture = document.createElement("canvas");
        texture.width = width;
        texture.height = height;
        const textureContext = texture.getContext("2d", { alpha: true });
        if (!textureContext) return;
        textureContext.imageSmoothingEnabled = true;
        textureContext.imageSmoothingQuality = "high";
        textureContext.drawImage(image, rect.x, rect.y, rect.width, rect.height,
                                 0, 0, width, height);
        stageWidth = width;
        stageHeight = height;
      }
      const markPainted = () => {
        if (paintedKeyRef.current !== selectedKey) {
          paintedKeyRef.current = selectedKey;
          setPaintedKey(selectedKey);
        }
      };
      const left = Math.floor((canvas.width - width) / 2);
      const top = canvas.height - height;
      if (!amount) {
        ctx.drawImage(texture, left, top);
        markPainted();
        return;
      }
      const seconds = milliseconds / 1000;
      for (let row = 0; row < Y_KNOTS.length - 1; row += 1) {
        const y0 = Y_KNOTS[row] * height;
        const y1 = Y_KNOTS[row + 1] * height;
        for (let column = 0; column < X_KNOTS.length - 1; column += 1) {
          const x0 = X_KNOTS[column] * width;
          const x1 = X_KNOTS[column + 1] * width;
          const s00 = { x: x0, y: y0 };
          const s10 = { x: x1, y: y0 };
          const s01 = { x: x0, y: y1 };
          const s11 = { x: x1, y: y1 };
          const offset = (point: Point): Point => {
            const moved = warp(point.x, point.y, width, height, seconds, amount, earAmount);
            return { x: moved.x + left, y: moved.y + top };
          };
          const d00 = offset(s00);
          const d10 = offset(s10);
          const d01 = offset(s01);
          const d11 = offset(s11);
          if (unmoved(s00, d00, left, top) && unmoved(s10, d10, left, top)
              && unmoved(s01, d01, left, top) && unmoved(s11, d11, left, top)) {
            ctx.drawImage(texture, x0, y0, x1 - x0, y1 - y0,
                          left + x0, top + y0, x1 - x0, y1 - y0);
            continue;
          }
          drawTriangle(ctx, texture, [s00, s10, s01], [d00, d10, d01]);
          drawTriangle(ctx, texture, [s11, s01, s10], [d11, d01, d10]);
        }
      }
      if (activity === "speaking" && !reducedMotion && !prefersReducedMotion && mouth
          && Number.isFinite(mouth.x) && Number.isFinite(mouth.y)
          && mouth.x >= 0 && mouth.x <= 1 && mouth.y >= 0 && mouth.y <= 1) {
        const opening = .5 + .5 * Math.sin(seconds * 13);
        const centerX = left + mouth.x * width;
        const centerY = top + mouth.y * height;
        ctx.fillStyle = "rgba(53, 31, 37, .82)";
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, Math.max(.8, width * .009),
                    Math.max(.45, height * (.0012 + .0023 * opening)), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(178, 122, 119, .55)";
        ctx.lineWidth = Math.max(.45, width * .002);
        ctx.beginPath();
        ctx.ellipse(centerX, centerY + height * .002, Math.max(.8, width * .009),
                    Math.max(.35, height * .0015), 0, .1, Math.PI - .1);
        ctx.stroke();
      }
      markPainted();
    }

    function tick(now: number) {
      if (!ticking) return;
      if (now - lastFrame >= FRAME_INTERVAL_MS) {
        draw(now);
        lastFrame = now;
      }
      raf = window.requestAnimationFrame(tick);
    }

    function startLoop() {
      if (amount && image && visible && !document.hidden && !ticking) {
        ticking = true;
        raf = window.requestAnimationFrame(tick);
      }
    }

    function stopLoop() {
      ticking = false;
      window.cancelAnimationFrame(raf);
    }

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => draw(performance.now())) : null;
    const intersection = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
        visible = entries[0]?.isIntersecting ?? true;
        if (visible) {
          draw(performance.now());
          startLoop();
        } else stopLoop();
      }) : null;
    const onVisibilityChange = () => {
      if (document.hidden) stopLoop();
      else {
        draw(performance.now());
        startLoop();
      }
    };
    observer?.observe(canvas);
    intersection?.observe(canvas);
    document.addEventListener("visibilitychange", onVisibilityChange);
    draw(performance.now());
    startLoop();
    return () => {
      stopLoop();
      observer?.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      texture = null;
    };
  }, [loaded, frame?.columns, frame?.rows, frame?.column, frame?.row, frame?.offsetX,
      activity, reducedMotion, prefersReducedMotion, safeRatio, mouth?.x, mouth?.y]);

  const fallbackX = spec.columns === 1 ? 0 : (spec.column + spec.offsetX) / (spec.columns - 1) * 100;
  const fallbackY = spec.rows === 1 ? 0 : spec.row / (spec.rows - 1) * 100;
  return <div data-expression={expression} style={{ position: "relative", width: "100%", height: "100%",
    overflow: "hidden", background: "transparent" }}>
    <div aria-hidden="true" style={{ position: "absolute", left: "50%", bottom: 0,
      width: fallbackSize.width, height: fallbackSize.height, transform: "translateX(-50%)",
      pointerEvents: "none", visibility: fallbackSize.width ? "visible" : "hidden",
      backgroundImage: loaded ? `url(${JSON.stringify(loaded.src)})` : undefined,
      backgroundSize: `${spec.columns * 100}% ${spec.rows * 100}%`,
      backgroundPosition: `${fallbackX}% ${fallbackY}%`, backgroundRepeat: "no-repeat",
      opacity: selectedKey && selectedKey === paintedKey ? 0 : 1 }} />
    <canvas ref={canvasRef} aria-hidden="true" role="presentation"
      style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%" }} />
  </div>;
}
