import { useEffect, useRef, useState, type ReactNode } from "react";
import { suggestCircuitRegion, type FrameRegion } from "./circuit-framing";
import { framedImageBox } from "./camera-framing-geometry";

export function suggestMediaRegion(media: HTMLVideoElement | HTMLImageElement): FrameRegion | null {
  const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 640 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    return suggestCircuitRegion(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  } catch { return null; }
  finally { canvas.width = canvas.height = 1; }
}

export default function CameraFraming({ region, width, height, children }: {
  region?: FrameRegion; width: number; height: number; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const box = region && size.width ? framedImageBox(size.width, size.height, width, height, region) : null;
  return <div className="camera-framing" ref={ref} data-focused={Boolean(region)}>
    <div className="camera-framing-media" style={box ?? undefined}>{children}</div>
  </div>;
}
