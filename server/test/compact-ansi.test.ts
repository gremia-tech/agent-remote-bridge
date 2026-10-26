import { expect, test } from "bun:test";
import { compactFrame } from "../src/backend/compact-ansi";
import { render } from "./ansi-screen";

/** Herdr-style frame: every cell repositioned and recoloured, with wide/Unicode text, links and colour runs. */
function herdrFrame(lines: string[], cols: number): Buffer {
  let out = "\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[H";
  lines.forEach((line, r) => {
    const chars = [...line.padEnd(cols)].slice(0, cols);
    chars.forEach((ch, c) => {
      const colour = /[0-9]/.test(ch) ? "0;32;49" : ch === "✓" ? "0;1;33;49" : "0;39;49";
      out += `\x1b[${r + 1};${c + 1}H\x1b[${colour}m${ch}`;
    });
  });
  return Buffer.from(out + "\x1b[3;5H\x1b[?25h\x1b[?2026l");
}

test("compacted frames render the same screen and are much smaller", () => {
  const lines = ["$ claude --resume", "✓ Edited src/app.ts (+12 −3)", "  läuft · 日本 · 42 tests", "", "> next prompt_"];
  const raw = herdrFrame(lines, 40), small = compactFrame(raw);
  expect(render([small], 40, 6)).toEqual(render([raw], 40, 6));
  expect(small.length * 4).toBeLessThan(raw.length);
  // Deltas apply on top of the previous screen identically.
  const delta = Buffer.from("\x1b[5;15H\x1b[0;39;49mx\x1b[5;16H\x1b[0;39;49my\x1b[1;1H\x1b[0;31;49m#");
  expect(render([small, compactFrame(delta)], 40, 6)).toEqual(render([raw, delta], 40, 6));
});

test("unknown sequences keep the following cursor move", () => {
  const input = Buffer.from("\x1b[1;1Ha\x1b[2K\x1b[1;2Hb\x1bc\x1b[0m\x1b[0m");
  const out = compactFrame(input).toString("latin1");
  expect(out).toContain("\x1b[1;2H");
  expect(out.match(/\x1b\[0m/g)).toHaveLength(1);
});
