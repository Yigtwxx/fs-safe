export function stringifyJsonDocument(
  value: unknown,
  replacer?: Parameters<typeof JSON.stringify>[1],
  space?: Parameters<typeof JSON.stringify>[2],
): string {
  const text = JSON.stringify(value, replacer, space);
  if (typeof text !== "string") {
    throw new TypeError("value is not representable as a JSON document");
  }
  return text;
}
