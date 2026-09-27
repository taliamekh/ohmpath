import { useEffect, useRef, useState } from "react";
import "./vision-overlay.css";
import type { FrameRegion } from "./circuit-framing";
import { framedImageBox, pointInFrame, WHOLE_FRAME } from "./camera-framing-geometry";

type Frame = { media: HTMLVideoElement | HTMLImageElement; stamp: number };
type Point = { x: number; y: number };
type Observation = {
  context_id: string; source: string; sequence: number;
  status: "tracking" | "lost" | "idle"; target: Point | null;
  quality: { brightness: number; contrast: number; sharpness: number; match: number };
  message: string; local_only: boolean; observation_only: boolean;
};

function dimensions(media: Frame["media"]) {
  return media instanceof HTMLVideoElement
    ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight];
}

async function request(action: string, payload: Record<string, unknown>) {
  if (!window.ohmpath) throw new Error("Local vision is unavailable.");
  return await window.ohmpath.request(action, payload);
}

async function clearContext(contextId: string) {
  // A frame already being decoded may temporarily hold the local vision slot.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await request("visionReset", { context_id: contextId }); return; }
    catch { if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 100)); }
  }
}

export default function VisionOverlay({ enabled, source, getFrame, region = WHOLE_FRAME }: {
  enabled: boolean; source: "overview" | "pi"; getFrame: () => Frame | null; region?: FrameRegion;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(getFrame);
  latest.current = getFrame;
  const context = useRef(crypto.randomUUID());
  const selected = useRef<Point | null>(null);
  const [selection, setSelection] = useState(0);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [message, setMessage] = useState("Click a textured point to follow it locally.");

  useEffect(() => {
    if (!enabled) { setObservation(null); selected.current = null; return; }
    const id = crypto.randomUUID();
    context.current = id;
    let stopped = false, faulted = false, timer: number | undefined, sequence = 0, stamp = -1;
    const scratch = document.createElement("canvas");
    setObservation(null);
    setMessage(selected.current ? "Finding that point…" : "Click a textured point to follow it locally.");

    async function tick() {
      if (stopped) return;
      try {
        const frame = latest.current();
        if (!frame) {
          setObservation(null);
          setMessage("Waiting for a fresh camera frame. Select the point again when the view returns.");
        } else if (frame.stamp !== stamp) {
          const [width, height] = dimensions(frame.media);
          if (!width || !height) throw new Error("Frame is not decoded.");
          const scale = Math.min(1, 640 / width, 480 / height);
          scratch.width = Math.max(1, Math.round(width * scale));
          scratch.height = Math.max(1, Math.round(height * scale));
          const painter = scratch.getContext("2d");
          if (!painter) throw new Error("Frame capture unavailable.");
          painter.drawImage(frame.media, 0, 0, scratch.width, scratch.height);
          const data = scratch.toDataURL("image/jpeg", .7);
          if (!data.startsWith("data:image/jpeg;base64,") || data.length > 700000) throw new Error("Frame exceeds limit.");
          const point = selected.current;
          selected.current = null;
          const currentSequence = ++sequence;
          const result = await request("visionFrame", { context_id: id, source,
            sequence: currentSequence, image_base64: data.slice(data.indexOf(",") + 1), ...(point ? { point } : {}) }) as Observation;
          if (stopped || context.current !== id) return;
          if (result.context_id !== id || result.source !== source || result.sequence !== currentSequence
              || !result.local_only || !result.observation_only || !["tracking", "lost", "idle"].includes(result.status)
              || result.target && (![result.target.x, result.target.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)))
            throw new Error("Invalid local vision result.");
          stamp = frame.stamp;
          setObservation(result);
          setMessage(result.message.slice(0, 220));
        }
      } catch {
        if (!stopped) {
          faulted = true;
          selected.current = null;
          setObservation(null);
          setMessage("Local tracking stopped after an error. Select a clear point again.");
          void clearContext(id);
        }
      } finally {
        if (!stopped && !faulted) timer = window.setTimeout(() => { void tick(); }, 160);
        else if (stopped) void clearContext(id);
      }
    }
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      scratch.width = scratch.height = 1;
      void clearContext(id);
    };
  }, [enabled, source, selection]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;
    function paint() {
      if (!canvas) return;
      const box = { width: canvas.clientWidth, height: canvas.clientHeight };
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
      const painter = canvas.getContext("2d");
      if (!painter) return;
      painter.clearRect(0, 0, canvas.width, canvas.height);
      const frame = latest.current();
      const target = observation?.status === "tracking" ? observation.target : null;
      if (!frame || !target) return;
      const [width, height] = dimensions(frame.media);
      if (target.x < region.x || target.x > region.x + region.width || target.y < region.y || target.y > region.y + region.height) return;
      const fitted = framedImageBox(box.width, box.height, width, height, region);
      painter.scale(ratio, ratio);
      const x = fitted.left + target.x * fitted.width, y = fitted.top + target.y * fitted.height;
      painter.lineWidth = 3; painter.strokeStyle = "#f5d982";
      painter.shadowColor = "#10251d"; painter.shadowBlur = 3;
      painter.beginPath(); painter.arc(x, y, 13, 0, Math.PI * 2); painter.stroke();
      painter.beginPath(); painter.moveTo(x - 23, y); painter.lineTo(x - 16, y);
      painter.moveTo(x + 16, y); painter.lineTo(x + 23, y);
      painter.moveTo(x, y - 23); painter.lineTo(x, y - 16);
      painter.moveTo(x, y + 16); painter.lineTo(x, y + 23); painter.stroke();
    }
    paint();
    const resize = new ResizeObserver(paint); resize.observe(canvas);
    return () => resize.disconnect();
  }, [enabled, observation, region]);

  function select(point: Point) {
    selected.current = point;
    setSelection(value => value + 1);
  }

  if (!enabled) return null;
  const target = observation?.status === "tracking" ? observation.target : null;
  const outside = target && (target.x < region.x || target.x > region.x + region.width || target.y < region.y || target.y > region.y + region.height);
  return <>
    <canvas ref={canvasRef} className="vision-overlay-target" role="button" tabIndex={0}
      aria-label="Select a visual tracking point; press Enter to select the image center"
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select({ x: region.x + region.width / 2, y: region.y + region.height / 2 }); } }}
      onClick={event => {
        const frame = latest.current();
        if (!frame) return;
        const [width, height] = dimensions(frame.media);
        const box = { width: event.currentTarget.clientWidth, height: event.currentTarget.clientHeight };
        const fitted = framedImageBox(box.width, box.height, width, height, region);
        const point = pointInFrame(event.nativeEvent.offsetX, event.nativeEvent.offsetY, fitted, region);
        if (point) select(point);
      }} />
    <div className="vision-overlay-status" aria-live="polite">
      <strong>{outside ? "Tracked point outside close-up" : observation?.status === "tracking" ? "Following selected point" : "Local visual tracking"}</strong>
      <span>{outside ? "Show the whole camera view or select a point in this close-up." : message}</span><small>Image position only · no electrical or aiming verification</small>
    </div>
  </>;
}
