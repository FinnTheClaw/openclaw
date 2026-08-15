export type FunctionalFinnCanonicalTextOptions = {
  maximumScalars: number;
  allowEmpty?: boolean;
};

export function isFunctionalFinnCanonicalText(
  value: unknown,
  options: FunctionalFinnCanonicalTextOptions,
): value is string {
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    return false;
  }
  if (value.normalize("NFC") !== value || Array.from(value).length > options.maximumScalars) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint < 0x20 && character !== "\n" && character !== "\t")
    ) {
      return false;
    }
  }
  return true;
}

function splitsSurrogatePair(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) {
    return false;
  }
  const prior = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return prior >= 0xd800 && prior <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Convert an exact JavaScript UTF-16 span into the IPC contract's UTF-8 byte span. */
export function resolveFunctionalFinnUtf8Span(params: {
  content: string;
  start: number;
  end: number;
  quote: string;
}): { startByte: number; endByte: number } | undefined {
  if (
    !Number.isSafeInteger(params.start) ||
    !Number.isSafeInteger(params.end) ||
    params.start < 0 ||
    params.end <= params.start ||
    params.end > params.content.length ||
    splitsSurrogatePair(params.content, params.start) ||
    splitsSurrogatePair(params.content, params.end) ||
    params.content.slice(params.start, params.end) !== params.quote ||
    !isFunctionalFinnCanonicalText(params.quote, { maximumScalars: 4_096 })
  ) {
    return undefined;
  }
  return {
    startByte: Buffer.byteLength(params.content.slice(0, params.start), "utf8"),
    endByte: Buffer.byteLength(params.content.slice(0, params.end), "utf8"),
  };
}
