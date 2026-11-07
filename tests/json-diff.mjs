// Lists the differences between two JSON values, including key order, as
// short human-readable lines such as `$.paths./a.get: missing key "tags"`.

function show(value) {
  const text = JSON.stringify(value);
  return text === undefined
    ? "undefined"
    : text.length > 80
      ? `${text.slice(0, 77)}...`
      : text;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffJson(expected, actual, at = "$", out = []) {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push(`${at}: expected ${expected.length} item(s), got ${actual.length}`);
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffJson(expected[index], actual[index], `${at}[${index}]`, out);
    }
    return out;
  }

  if (isObject(expected) && isObject(actual)) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    for (const key of expectedKeys) {
      if (!(key in actual)) {
        out.push(`${at}: missing key "${key}" (expected ${show(expected[key])})`);
      }
    }
    for (const key of actualKeys) {
      if (!(key in expected)) {
        out.push(`${at}: unexpected key "${key}" = ${show(actual[key])}`);
      }
    }
    const shared = expectedKeys.filter((key) => key in actual);
    const actualOrder = actualKeys.filter((key) => key in expected);
    if (shared.join("\u0000") !== actualOrder.join("\u0000")) {
      out.push(
        `${at}: key order expected [${shared.join(", ")}], got [${actualOrder.join(", ")}]`,
      );
    }
    for (const key of shared) {
      diffJson(expected[key], actual[key], `${at}.${key}`, out);
    }
    return out;
  }

  if (!Object.is(expected, actual) && show(expected) !== show(actual)) {
    out.push(`${at}: expected ${show(expected)}, got ${show(actual)}`);
  }
  return out;
}
