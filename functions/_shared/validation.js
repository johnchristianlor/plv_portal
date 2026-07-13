export function cleanString(value, max = 500, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw Object.assign(new Error('A required field is missing.'), { status: 422, code: 'validation_failed' });
  if (text.length > max) throw Object.assign(new Error('Text is too long.'), { status: 422, code: 'validation_failed' });
  return text;
}

export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function numberIn(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function jsonText(value, max = 20000) {
  const text = JSON.stringify(value ?? null);
  if (text.length > max) throw Object.assign(new Error('Payload contains too much data.'), { status: 422, code: 'validation_failed' });
  return text;
}
