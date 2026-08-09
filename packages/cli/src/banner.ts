import { PRODUCT_SLUG } from '@product'

import type { Io } from './io'

/**
 * A decorative block-letter wordmark for `init`, and nothing else.
 *
 * §11's whole design is "an agent runs this unattended" — no colour, no
 * spinners, one fact per line (see the note in `io.ts`). This banner does not
 * relax that: it is gated on `io.isTTY`, which is `false` for every pipe, every
 * test, and every agent that captures output rather than attaching a real
 * terminal. A human running `init` by hand sees it once; nothing else changes.
 */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  W: ['#.....#', '#.....#', '#.....#', '#..#..#', '#.#.#.#', '##...##', '#.....#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#.#.#', '#..##', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
}

const ROWS: number = 7
const WORD = PRODUCT_SLUG.toUpperCase()
const ESC = String.fromCharCode(27)

/** Violet → blue, the same pair `docs/media` and the landing page use. */
const GRADIENT_FROM = [139, 124, 255] as const
const GRADIENT_TO = [30, 96, 140] as const

function rowsOf(word: string): readonly string[] {
  const lines: string[] = []
  for (let row = 0; row < ROWS; row++) {
    let line = ''
    for (const ch of word) {
      const glyph = GLYPHS[ch]
      line += `${glyph === undefined ? ' '.repeat(5) : glyph[row]} `
    }
    lines.push(line)
  }
  return lines
}

function lerp(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t)
}

export function printBanner(io: Io): void {
  if (!io.isTTY || io.env['NO_COLOR'] !== undefined) return

  const lines = rowsOf(WORD)
  const width = lines[0]?.length ?? 0
  let out = '\n'

  lines.forEach((rowText, i) => {
    const t = ROWS === 1 ? 0 : i / (ROWS - 1)
    const r = lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t)
    const g = lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t)
    const b = lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t)
    const rendered = rowText.replace(/#/gu, '█').replace(/\./gu, ' ')
    out += `${ESC}[38;2;${r};${g};${b}m${ESC}[1m${rendered}${ESC}[0m\n`
  })

  // A dim, right-shifted echo of the baseline — a cheap drop shadow that needs
  // no cursor-position tricks, so it renders the same in every terminal.
  const shadow = (lines[ROWS - 1] ?? '').replace(/#/gu, '░').replace(/\./gu, ' ')
  out += ` ${ESC}[38;2;40;38;64m${shadow.slice(0, Math.max(0, width - 1))}${ESC}[0m\n`
  out += `${ESC}[2m${PRODUCT_SLUG}.dev — build once, let owners edit${ESC}[0m\n`

  io.write(out)
}
