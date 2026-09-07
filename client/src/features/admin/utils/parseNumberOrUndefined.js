// parseInt/parseFloat return NaN for cleared/invalid input; NaN serializes to
// null in JSON and is rejected by the strict server schema, so fall back to undefined.
export default function parseNumberOrUndefined(value, parser = parseFloat) {
  const n = parser(value);
  return Number.isFinite(n) ? n : undefined;
}
