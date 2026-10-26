/**
 * Herdr frames position the cursor and reset the colour before every cell
 * (`ESC[r;cH ESC[0;39;49m x` for each character). Drop the moves that land
 * where the cursor already is and colour changes that repeat the current one.
 * The rendered screen is identical; full frames shrink by roughly 5-10x.
 *
 * Conservative by design: state is tracked only through printable ASCII
 * (always one column wide). Any other byte or sequence makes the cursor
 * position unknown, so the next move is always kept. State resets per frame.
 */
export function compactFrame(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let length = 0, row = -1, col = -1;
  let sgr: string | null = null;
  const copy = (from: number, to: number) => { input.copy(out, length, from, to); length += to - from; };
  const n = input.length;
  let i = 0;
  while (i < n) {
    const b = input[i]!;
    if (b === 0x1b && input[i + 1] === 0x5b) {
      let j = i + 2;
      while (j < n && input[j]! >= 0x20 && input[j]! <= 0x3f) j++;
      if (j >= n) { copy(i, n); break; }
      const final = input[j]!, params = input.toString("latin1", i + 2, j);
      if (final === 0x48 && /^\d*(;\d*)?$/.test(params)) {
        const [r, c] = params.split(";");
        const nextRow = Number(r || 1), nextCol = Number(c || 1);
        if (nextRow === row && nextCol === col) { i = j + 1; continue; }
        row = nextRow; col = nextCol;
      } else if (final === 0x6d && /^[\d;]*$/.test(params)) {
        if (params === sgr) { i = j + 1; continue; }
        sgr = params;
      } else {
        row = -1; col = -1;
        if (final === 0x70) sgr = null; // DECSTR and friends can reset attributes
      }
      copy(i, j + 1); i = j + 1; continue;
    }
    if (b === 0x1b && input[i + 1] === 0x5d) {
      // OSC (e.g. hyperlinks) does not move the cursor; copy through its terminator.
      let j = i + 2;
      while (j < n && input[j] !== 0x07 && !(input[j] === 0x1b && input[j + 1] === 0x5c)) j++;
      j = j >= n ? n : input[j] === 0x07 ? j + 1 : j + 2;
      copy(i, j); i = j; continue;
    }
    if (b === 0x1b) {
      const end = Math.min(n, i + 2);
      copy(i, end); i = end; row = -1; col = -1; sgr = null; continue;
    }
    out[length++] = b; i++;
    if (b >= 0x20 && b < 0x7f) { if (col > 0) col++; }
    else { row = -1; col = -1; }
  }
  return out.subarray(0, length);
}
