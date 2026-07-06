import { nodeColor } from "../lib/federation";

interface NodeBadgeProps {
  node: string;
  isLocal?: boolean;
  size?: "sm" | "md";
}

/** Color-coded pill showing which federation node an agent belongs to. */
export default function NodeBadge({ node, isLocal, size = "sm" }: NodeBadgeProps) {
  const { accent, label } = nodeColor(node);
  const px = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${px}`}
      style={{ backgroundColor: accent + "20", color: accent, border: `1px solid ${accent}40` }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: accent }}
      />
      {label}
      {isLocal && <span className="opacity-50">(local)</span>}
    </span>
  );
}
