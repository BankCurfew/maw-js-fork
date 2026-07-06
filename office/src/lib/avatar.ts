const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6",
  "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899",
];

const SKIN_COLORS = ["#fde2c8", "#f5c5a0", "#d4956b", "#a0714f", "#6b4226", "#ffe0bd"];
const HAIR_COLORS = ["#2c1b0e", "#5a3214", "#c2884a", "#e8c068"];

type HairStyle = "short" | "spiky" | "side-part" | "curly" | "buzz";
type EyeStyle = "dot" | "line" | "wide";

const HAIR_STYLES: HairStyle[] = ["short", "spiky", "side-part", "curly", "buzz"];
const EYE_STYLES: EyeStyle[] = ["dot", "line", "wide"];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface AvatarData {
  hairStyle: HairStyle;
  eyeStyle: EyeStyle;
  skinColor: string;
  hairColor: string;
  shirtColor: string;
}

export function generateAvatar(id: string): AvatarData {
  const h = hash(id);
  const bits = (offset: number, count: number) => (h >>> offset) % count;
  return {
    hairStyle: HAIR_STYLES[bits(3, HAIR_STYLES.length)],
    eyeStyle: EYE_STYLES[bits(6, EYE_STYLES.length)],
    skinColor: SKIN_COLORS[bits(8, SKIN_COLORS.length)],
    hairColor: HAIR_COLORS[bits(11, HAIR_COLORS.length)],
    shirtColor: PALETTE[h % PALETTE.length],
  };
}
