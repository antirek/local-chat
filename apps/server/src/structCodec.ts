/**
 * Decode google.protobuf.Struct (proto-loader shape) → plain JSON.
 * Also accepts already-plain objects (pass-through).
 */
export function structToPlain(value: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(structToPlain);
  if (typeof value !== 'object') return value;

  // protobuf Value
  if ('stringValue' in value && Object.keys(value).length <= 2) return value.stringValue;
  if ('numberValue' in value && Object.keys(value).length <= 2) return value.numberValue;
  if ('boolValue' in value && Object.keys(value).length <= 2) return value.boolValue;
  if ('nullValue' in value && Object.keys(value).length <= 2) return null;
  if (value.structValue) return structToPlain(value.structValue);
  if (value.listValue?.values) return value.listValue.values.map(structToPlain);

  // protobuf Struct
  if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.fields)) {
      out[k] = structToPlain(v);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = structToPlain(v);
  }
  return out;
}

/** Normalize a Chat3 gRPC Update for browser WS (plain `data`). */
export function normalizeGrpcUpdate(update: any): any {
  if (!update || typeof update !== 'object') return update;
  return {
    ...update,
    data: structToPlain(update.data)
  };
}
