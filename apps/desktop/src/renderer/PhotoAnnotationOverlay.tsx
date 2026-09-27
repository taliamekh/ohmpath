import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FrameRegion } from "./circuit-framing";

export type PhotoAnnotation = { image_id: string; x: number; y: number; label: string };

type Props = {
  image: { image_id: string; data_url: string; name: string; width: number; height: number };
  notes: PhotoAnnotation[];
  crop?: FrameRegion;
  zoom: number;
  activeNote: number | null;
  onActiveNote: (index: number | null) => void;
};

type IndexedAnnotation = PhotoAnnotation & { index: number };
type AnnotationLine = { index: number; x1: number; y1: number; x2: number; y2: number };

export default function PhotoAnnotationOverlay({ image, notes, crop, zoom, activeNote, onActiveNote }: Props) {
  const [annotationLines, setAnnotationLines] = useState<AnnotationLine[]>([]);
  const annotationLayoutRef = useRef<HTMLDivElement | null>(null);
  const annotationAnchorRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const annotationLabelRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const orderedNotes = useMemo<IndexedAnnotation[]>(() => notes.map((note, index) => ({ ...note, index })).sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index), [notes]);
  const annotationSignature = notes.map((note, index) => `${index}:${note.x}:${note.y}:${note.label}`).join("|");

  useLayoutEffect(() => {
    const layout = annotationLayoutRef.current;
    if (!layout || !notes.length) {
      setAnnotationLines(current => current.length ? [] : current);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const layoutBox = layout.getBoundingClientRect();
      const next = orderedNotes.flatMap(note => {
        const anchor = annotationAnchorRefs.current[note.index];
        const label = annotationLabelRefs.current[note.index];
        if (!anchor || !label || anchor.hidden) return [];
        const anchorBox = anchor.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        return [{
          index: note.index,
          x1: anchorBox.left + anchorBox.width / 2 - layoutBox.left,
          y1: anchorBox.top + anchorBox.height / 2 - layoutBox.top,
          x2: labelBox.left - layoutBox.left,
          y2: labelBox.top + labelBox.height / 2 - layoutBox.top,
        }];
      });
      setAnnotationLines(current => current.length === next.length && current.every((line, index) => {
        const candidate = next[index];
        return candidate && line.index === candidate.index && Math.abs(line.x1 - candidate.x1) < .5 && Math.abs(line.y1 - candidate.y1) < .5
          && Math.abs(line.x2 - candidate.x2) < .5 && Math.abs(line.y2 - candidate.y2) < .5;
      }) ? current : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(layout);
    layout.addEventListener("scroll", schedule, true);
    return () => { if (frame) window.cancelAnimationFrame(frame); observer?.disconnect(); layout.removeEventListener("scroll", schedule, true); };
  }, [annotationSignature, crop?.x, crop?.y, crop?.width, crop?.height, image.image_id, zoom]);

  return <div className={`photo-help-annotation-layout${notes.length ? " has-annotations" : ""}`} ref={annotationLayoutRef} style={{ width: `${zoom * 100}%` }}>
    <div className="photo-help-image-column">
      <div className="photo-help-image-wrap" data-closeup={Boolean(crop)} style={{ width: "100%", aspectRatio: `${image.width * (crop?.width ?? 1)} / ${image.height * (crop?.height ?? 1)}` }}>
        <div className="photo-help-image-coordinates" style={crop ? { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%` } : undefined}>
          <img src={image.data_url} alt={image.name || "Selected circuit image"} draggable={false} />
          {notes.map((note, index) => <button type="button" key={`${image.image_id}-${index}`} ref={element => { annotationAnchorRefs.current[index] = element; }} className={`photo-help-marker ${activeNote === index ? "active" : ""}`} style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }} hidden={Boolean(crop && (note.x < crop.x || note.x > crop.x + crop.width || note.y < crop.y || note.y > crop.y + crop.height))} title={note.label} aria-label={`Annotation ${index + 1}: ${note.label}`} onClick={() => onActiveNote(activeNote === index ? null : index)}><span>{index + 1}</span></button>)}
        </div>
      </div>
    </div>
    {notes.length > 0 && <aside className="photo-help-annotation-rail" aria-label="Image annotations">
      <div className="photo-help-annotation-rail-heading">Visible details</div>
      <ol className="photo-help-annotation-list">
        {orderedNotes.map(note => <li key={`${image.image_id}-annotation-${note.index}`}>
          <button type="button" ref={element => { annotationLabelRefs.current[note.index] = element; }} className={`photo-help-annotation-label ${activeNote === note.index ? "active" : ""}`} onClick={() => onActiveNote(activeNote === note.index ? null : note.index)} aria-label={`Focus detail ${note.index + 1}: ${note.label}`}><span>{note.index + 1}</span><strong>{note.label}</strong></button>
        </li>)}
      </ol>
    </aside>}
    {notes.length > 0 && <svg className="photo-help-annotation-lines" aria-hidden="true" focusable="false">
      {annotationLines.map(line => <polyline key={line.index} points={`${line.x1},${line.y1} ${line.x1 + 12},${line.y1} ${line.x2},${line.y2}`} />)}
    </svg>}
  </div>;
}
