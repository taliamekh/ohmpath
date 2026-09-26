import CharacterRig, { type CharacterRigProps } from "./CharacterRig";
import "./frieren-guide.css";

export type GuideExpression = "neutral" | "thinking" | "stumped" | "happy" | "smug" | "weary";
type Props = {
  activity: "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";
  expression?: GuideExpression;
  reducedMotion?: boolean;
  compact?: boolean;
};
const gestures = new URL("./assets/frieren/gestures.png", import.meta.url).href;
const cells: Record<GuideExpression, [number, number]> = {
  neutral: [0, 0], thinking: [1, 0], stumped: [2, 0],
  happy: [0, 1], smug: [1, 1], weary: [2, 1],
};
// Centers and masks measured from the supplied artwork after each cell's
// offsetX crop. The happy cell provides matching artist-drawn closed eyelids.
const closedFrame = { columns: 3, rows: 2, column: 0, row: 1, offsetX: .063 };
const blinks: Array<NonNullable<CharacterRigProps["blink"]>> = [
  { frame: closedFrame, eyes: [
    { open: { x: .443, y: .190 }, closed: { x: .430, y: .191 }, radiusX: .043, sourceRadiusX: .039, radiusY: .024 },
    { open: { x: .560, y: .189 }, closed: { x: .568, y: .183 }, radiusX: .045, sourceRadiusX: .037, radiusY: .025 },
  ] },
  { frame: closedFrame, eyes: [
    { open: { x: .435, y: .187 }, closed: { x: .430, y: .191 }, radiusX: .043, sourceRadiusX: .039, radiusY: .026 },
    { open: { x: .554, y: .185 }, closed: { x: .568, y: .183 }, radiusX: .045, sourceRadiusX: .037, radiusY: .026 },
  ] },
  { frame: closedFrame, eyes: [
    { open: { x: .430, y: .192 }, closed: { x: .430, y: .191 }, radiusX: .043, sourceRadiusX: .039, radiusY: .022 },
    { open: { x: .552, y: .188 }, closed: { x: .568, y: .183 }, radiusX: .045, sourceRadiusX: .037, radiusY: .026 },
  ] },
];

export default function FrierenGuide({ activity, expression, reducedMotion = false, compact = false }: Props) {
  const face = activity === "thinking" ? "thinking" : activity === "error" ? "stumped" : expression ?? "neutral";
  const [column, row] = cells[face];
  const mouthY = row === 0 ? .248 : face === "smug" ? .225 : .240;
  return <div className={`frieren-guide ${compact ? "compact" : ""} ${reducedMotion ? "still" : ""} activity-${activity}`}
    data-expression={face} role="img" aria-label={`Frieren · ${face}`}>
    <div className="frieren-sprite-stage">
      <div className="frieren-sprite" data-source={gestures}>
        <CharacterRig src={gestures} frame={{ columns: 3, rows: 2, column, row, offsetX: [.063, -.007, -.050][column] }}
          aspectRatio={3 / 4} mouth={{ x: .5, y: mouthY }} blink={row === 0 ? blinks[column] : undefined}
          activity={activity} expression={face} reducedMotion={reducedMotion} />
      </div>
    </div>
  </div>;
}
