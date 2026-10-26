/** Minimal screen model for comparing frame encodings: cursor moves, SGR state, text, erase. */
export function render(chunks: Buffer[], cols: number, rows: number): string[] {
  const cells: string[][] = Array.from({ length: rows }, () => Array(cols).fill(" |0"));
  let r = 0, c = 0, sgr = "0";
  const text = Buffer.concat(chunks).toString("utf8");
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === "\x1b" && text[i + 1] === "[") {
      let j = i + 2; while (j < text.length && /[\x20-\x3f]/.test(text[j]!)) j++;
      const params = text.slice(i + 2, j), final = text[j];
      if (final === "H") { const [a, b] = params.split(";"); r = Number(a || 1) - 1; c = Number(b || 1) - 1; }
      else if (final === "m" && /^[\d;]*$/.test(params)) sgr = params || "0";
      else if (final === "J" && params === "2") for (const line of cells) line.fill(" |0");
      i = j + 1; continue;
    }
    if (ch === "\x1b" && text[i + 1] === "]") { let j = i + 2; while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++; i = text[j] === "\x07" ? j + 1 : j + 2; continue; }
    if (ch === "\x1b") { i += 2; continue; }
    const code = text.codePointAt(i)!, width = code > 0xffff ? 2 : 1;
    if (code >= 0x20) { if (r >= 0 && r < rows && c >= 0 && c < cols) cells[r]![c] = `${String.fromCodePoint(code)}|${sgr}`; c++; }
    else if (code === 0x0d) c = 0; else if (code === 0x0a) r++;
    i += width;
  }
  return cells.map(line => line.join(""));
}
