/**
 * Minimal QR Code Generator — pure TypeScript, zero dependencies
 * Supports: Byte mode, Error Correction Level L, Versions 1-5
 * Output: boolean[][] matrix or SVG string
 */

// --- GF(256) arithmetic for Reed-Solomon ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x & 128 ? ((x << 1) ^ 0x11d) & 0xff : (x << 1) & 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

// Reed-Solomon error correction codewords
function rsEncode(data: number[], ecLen: number): number[] {
  // Build generator polynomial: g(x) = Π(x + α^i) for i=0..ecLen-1
  // Stored highest degree first: [1, g1, g2, ..., g_ecLen]
  const gen = new Array(ecLen + 1).fill(0);
  gen[0] = 1;
  for (let i = 0; i < ecLen; i++) {
    for (let j = ecLen; j >= 1; j--) {
      gen[j] = gfMul(gen[j], EXP[i]) ^ gen[j - 1];
    }
    gen[0] = gfMul(gen[0], EXP[i]);
  }
  // Polynomial division: remainder of (data * x^ecLen) / g(x)
  const msg = [...data, ...new Array(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j <= ecLen; j++) {
      msg[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return msg.slice(data.length);
}

// --- Version data (EC Level L only) ---
interface VersionInfo {
  size: number;       // Module count (21 + 4*(v-1))
  totalCW: number;    // Total codewords
  ecCW: number;       // EC codewords per block
  dataCW: number;     // Data codewords
  align: number[];    // Alignment pattern center positions
}

const VERSIONS: VersionInfo[] = [
  { size: 21, totalCW: 26,  ecCW: 7,  dataCW: 19,  align: [] },           // V1
  { size: 25, totalCW: 44,  ecCW: 10, dataCW: 34,  align: [6, 18] },      // V2
  { size: 29, totalCW: 70,  ecCW: 15, dataCW: 55,  align: [6, 22] },      // V3
  { size: 33, totalCW: 100, ecCW: 20, dataCW: 80,  align: [6, 26] },      // V4
  { size: 37, totalCW: 134, ecCW: 26, dataCW: 108, align: [6, 30] },      // V5
];

// Select smallest version that fits the data
function selectVersion(dataLen: number): { ver: number; info: VersionInfo } {
  // Byte mode overhead: 4 bits mode + 8 bits count (V1-9) = 12 bits = 1.5 bytes
  // Plus 4-bit terminator. Effective data capacity = dataCW - 2 (conservative)
  for (let i = 0; i < VERSIONS.length; i++) {
    if (dataLen <= VERSIONS[i].dataCW - 2) {
      return { ver: i + 1, info: VERSIONS[i] };
    }
  }
  throw new Error(`Data too long (${dataLen} bytes), max ${VERSIONS[VERSIONS.length - 1].dataCW - 2}`);
}

// --- Data encoding (byte mode) ---
function encodeData(text: string, info: VersionInfo): number[] {
  const bytes = new TextEncoder().encode(text);
  const bits: number[] = [];

  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Mode indicator: 0100 (byte mode)
  push(0b0100, 4);
  // Character count (8 bits for V1-9)
  push(bytes.length, 8);
  // Data bytes
  for (const b of bytes) push(b, 8);
  // Terminator (up to 4 zero bits)
  const maxBits = info.dataCW * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  push(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes: alternating 0xEC, 0x11
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < maxBits) {
    push(pads[pi], 8);
    pi ^= 1;
  }

  // Convert bits to bytes
  const result: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    result.push(byte);
  }
  return result;
}

// --- Matrix construction ---
type Matrix = (boolean | null)[][]; // true=dark, false=light, null=unset

function createMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function setModule(m: Matrix, r: number, c: number, dark: boolean) {
  if (r >= 0 && r < m.length && c >= 0 && c < m.length) m[r][c] = dark;
}

// Finder pattern (7x7) at top-left corner (row, col)
function placeFinderPattern(m: Matrix, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      setModule(m, row + r, col + c, inOuter ? (onBorder || inInner) : false);
    }
  }
}

// Alignment pattern (5x5) centered at (row, col)
function placeAlignmentPattern(m: Matrix, row: number, col: number) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const onBorder = Math.abs(r) === 2 || Math.abs(c) === 2;
      const isCenter = r === 0 && c === 0;
      setModule(m, row + r, col + c, onBorder || isCenter);
    }
  }
}

function placeFixedPatterns(m: Matrix, info: VersionInfo) {
  const size = info.size;

  // Finder patterns + separators
  placeFinderPattern(m, 0, 0);
  placeFinderPattern(m, 0, size - 7);
  placeFinderPattern(m, size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }

  // Alignment patterns (skip if overlapping with finder)
  if (info.align.length >= 2) {
    const positions = info.align;
    for (const r of positions) {
      for (const c of positions) {
        // Skip if overlaps with finder patterns
        if (r <= 8 && c <= 8) continue;                    // top-left
        if (r <= 8 && c >= size - 8) continue;             // top-right
        if (r >= size - 8 && c <= 8) continue;             // bottom-left
        placeAlignmentPattern(m, r, c);
      }
    }
  }

  // Dark module (always present)
  m[size - 8][8] = true;

  // Reserve format info areas (will be written later)
  // Horizontal: row 8, cols 0-8 and size-8..size-1
  // Vertical: col 8, rows 0-8 and size-8..size-1
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = size - 8; i < size; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
}

// BCH(15,5) for format info
function formatInfo(ecLevel: number, mask: number): number {
  const data = (ecLevel << 3) | mask;
  let d = data << 10;
  // Generator: x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 = 0b10100110111
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if (d & (1 << i)) d ^= gen << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

function writeFormatInfo(m: Matrix, mask: number) {
  const size = m.length;
  const info = formatInfo(0b01, mask); // EC Level L = 01

  // Bits 0-7 go to specific positions around top-left finder
  const posA: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  // Mirror positions
  const posB: [number, number][] = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];

  for (let i = 0; i < 15; i++) {
    const bit = ((info >> i) & 1) === 1;
    m[posA[i][0]][posA[i][1]] = bit;
    m[posB[i][0]][posB[i][1]] = bit;
  }
}

// Place data bits in zigzag pattern
function placeData(m: Matrix, dataBits: number[]) {
  const size = m.length;
  let bitIdx = 0;
  let upward = true;

  // Process two-column bands from right to left
  for (let right = size - 1; right >= 1; right -= 2) {
    // Skip timing pattern column
    if (right === 6) right = 5;

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const col of [right, right - 1]) {
        if (col < 0) continue;
        if (m[row][col] !== null) continue; // Already occupied by function pattern
        m[row][col] = bitIdx < dataBits.length ? dataBits[bitIdx++] === 1 : false;
      }
    }
    upward = !upward;
  }
}

// --- Masking ---
const MASK_FNS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r, _) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function applyMask(m: Matrix, reserved: Matrix, maskIdx: number): Matrix {
  const size = m.length;
  const result = m.map(row => [...row]);
  const fn = MASK_FNS[maskIdx];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c] !== null) continue; // Don't mask function patterns
      if (fn(r, c)) result[r][c] = !result[r][c];
    }
  }
  return result;
}

// Penalty score (simplified — evaluates adjacent runs + 2x2 blocks)
function penaltyScore(m: Matrix): number {
  const size = m.length;
  let score = 0;

  // Rule 1: Runs of same color (rows and columns)
  for (let r = 0; r < size; r++) {
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) { runLen++; }
      else { if (runLen >= 5) score += runLen - 2; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }
  for (let c = 0; c < size; c++) {
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c] === m[r - 1][c]) { runLen++; }
      else { if (runLen >= 5) score += runLen - 2; runLen = 1; }
    }
    if (runLen >= 5) score += runLen - 2;
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  return score;
}

// --- Main entry point ---
export function generateQR(text: string): boolean[][] {
  const { info } = selectVersion(new TextEncoder().encode(text).length);

  // Encode data
  const dataWords = encodeData(text, info);
  const ecWords = rsEncode(dataWords, info.ecCW);

  // Interleave (single block for V1-V5 L, so just concatenate)
  const allWords = [...dataWords, ...ecWords];

  // Convert to bit array
  const bits: number[] = [];
  for (const w of allWords) {
    for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  }

  // Build reserved pattern matrix (to know which cells are function patterns)
  const reserved = createMatrix(info.size);
  placeFixedPatterns(reserved, info);

  // Build data matrix
  const matrix = createMatrix(info.size);
  placeFixedPatterns(matrix, info);
  placeData(matrix, bits);

  // Try all 8 masks, pick lowest penalty
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(matrix, reserved, mask);
    writeFormatInfo(masked, mask);
    const score = penaltyScore(masked);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
  }

  // Apply best mask
  const final = applyMask(matrix, reserved, bestMask);
  writeFormatInfo(final, bestMask);

  return final.map(row => row.map(cell => cell === true));
}

export function generateQRSvg(text: string, cellSize = 4, quietZone = 4): string {
  const modules = generateQR(text);
  const size = modules.length;
  const totalSize = (size + quietZone * 2) * cellSize;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}">`;
  svg += `<rect width="${totalSize}" height="${totalSize}" fill="#fff"/>`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        const x = (c + quietZone) * cellSize;
        const y = (r + quietZone) * cellSize;
        svg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#000"/>`;
      }
    }
  }

  svg += "</svg>";
  return svg;
}
