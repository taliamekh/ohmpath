import "./frieren-guide.css";

export type GuideExpression = "neutral" | "thinking" | "stumped" | "happy";
type Props = {
  activity: "idle" | "listening" | "thinking" | "speaking" | "paused" | "error";
  expression?: GuideExpression;
  reducedMotion?: boolean;
  compact?: boolean;
};
const neutral = new URL("./assets/frieren/neutral.png", import.meta.url).href;
const expressions = new URL("./assets/frieren/expressions.png", import.meta.url).href;
const animation = new URL("./assets/frieren/animation.png", import.meta.url).href;

export default function FrierenGuide({ activity, expression, reducedMotion = false, compact = false }: Props) {
  const face = activity === "thinking" ? "thinking" : activity === "error" ? "stumped" : expression ?? "neutral";
  return <div className={`frieren-guide ${compact ? "compact" : ""} ${reducedMotion ? "still" : ""} activity-${activity}`}
    data-expression={face} role="img" aria-label={`Frieren · ${face}`}>
    <div className="frieren-sprite-stage">
      <div className="frieren-sprite" style={{ backgroundImage: `url("${face === "neutral" ? neutral : expressions}")` }} />
      <div className="frieren-blink" style={{ backgroundImage: `url("${animation}")` }} />
      <div className="frieren-talk" style={{ backgroundImage: `url("${animation}")` }} />
    </div>
  </div>;
}
