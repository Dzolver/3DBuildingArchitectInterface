/** Format metres for display: up to 3 decimals, trailing zeros trimmed. */
export function fmt(m: number): string {
  const v = Math.round(m * 1000) / 1000;
  return `${Number.isInteger(v) ? v.toString() : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} m`;
}
