import CharacterRig from "./CharacterRig";
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
// Eye positions were measured against the three open-eye cells in gestures.png.
// The lower-row expressions already have closed eyes in the supplied art.
const openEyes: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
  [{ x: .455, y: .188 }, { x: .575, y: .188 }],
  [{ x: .469, y: .188 }, { x: .591, y: .188 }],
  [{ x: .480, y: .188 }, { x: .600, y: .188 }],
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
          aspectRatio={3 / 4} mouth={{ x: .5, y: mouthY }} eyes={row === 0 ? openEyes[column] : undefined}
          activity={activity} expression={face} reducedMotion={reducedMotion} />
      </div>
    </div>
  </div>;
}
