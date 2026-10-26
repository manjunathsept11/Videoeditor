/** Pull the first complete JSON object or array out of model output (handles ``` fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const c of candidates) {
    const slice = firstBalanced(c);
    if (slice !== undefined) return JSON.parse(slice);
  }
  throw new Error('no JSON object found in the response');
}

function firstBalanced(s: string): string | undefined {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
