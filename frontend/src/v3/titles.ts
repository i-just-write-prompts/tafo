/** Week titles: hyphenate, then tighten by at most 0.35px, then fade. */

export const MAX_TRACK = 0.35;

const HYPH: Record<string, string> = {
  Groceries: "Groc",
  Grandma: "Grand",
  Design: "De",
  Standup: "Stand",
  review: "re",
  Dentist: "Den",
  cleaning: "clean",
  vendor: "ven",
  report: "re",
  Brunch: "Brunch",
};

export interface TitleLayout {
  lines: string[];
  faded: boolean;
}

export function wrapWeekTitle(
  text: string,
  width: number,
  maxLines: number,
  measure: (value: string) => number,
): TitleLayout {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  let index = 0;
  const fits = (value: string) => measure(value) - MAX_TRACK * Math.max(value.length - 1, 0) <= width;
  while (index < words.length) {
    const word = words[index];
    const candidate = (current ? `${current} ${word}` : word);
    if (measure(candidate) <= width || (!current && fits(candidate))) {
      current = candidate;
      index += 1;
      continue;
    }
    const head = HYPH[word];
    const broken = head && head !== word ? `${head}-` : "";
    if (
      broken
      && !fits(word)
      && lines.length + 1 < maxLines
      && fits((current ? `${current} ${broken}` : broken).trim())
    ) {
      lines.push((current ? `${current} ${broken}` : broken).trim());
      current = "";
      words[index] = word.slice(head.length);
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
      continue;
    }
    current = word;
    index += 1;
  }
  if (current) lines.push(current);
  const clipped = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" ")] : lines;
  const faded = clipped.some((line) => measure(line) - MAX_TRACK * Math.max(line.length - 1, 0) > width + 0.01);
  return { lines: clipped, faded };
}
