import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const VALUE_BITS = 0x7f;
const CONTINUE_BIT = 0x80;
const BITS_PER_BYTE = 7;
const MAX_VARINT_BYTES = 5;
const MAX_GREETING_BYTES = 2048;
const PORT_BYTES = 2;
const HANDSHAKE_PACKET = 0x00;
const STATUS_RESPONSE_PACKET = 0x00;
const PING_PACKET = 0x01;
const STATUS_QUERY_PACKET = 0x00;
const LOGIN_DISCONNECT_PACKET = 0x00;
const STATUS_STATE = 1;
const LOGIN_STATE = 2;
const TRANSFER_STATE = 3;
const MINECRAFT_STATES: ReadonlySet<number> = new Set([STATUS_STATE, LOGIN_STATE, TRANSFER_STATE]);
const PING_BODY_BYTES = 9;
const STATUS_QUERY_BODY_BYTES = 1;
const INCOMPATIBLE_PROTOCOL = -1;
const WAKING_STATUS = `{"version":{"name":"Waking up","protocol":${INCOMPATIBLE_PROTOCOL}},"players":{"max":0,"online":0},"description":{"text":"Waking up. Refresh in 30 seconds."}}`;
const WAKING_DISCONNECT = '{"text":"The server is waking up. Join again in 30 seconds."}';

export class ProtocolFailure extends Data.TaggedError("ProtocolFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const textEncoder = new TextEncoder();

const concat = (parts: readonly Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));

const readVarint = (
  bytes: Uint8Array,
  offset: number,
  index = 0,
  value = 0,
): { readonly value: number; readonly end: number } | undefined => {
  const byte = bytes[offset + index];
  const missing = byte === undefined || index === MAX_VARINT_BYTES;
  if (missing) {
    return undefined;
  }
  const decoded = value | ((byte & VALUE_BITS) << (index * BITS_PER_BYTE));
  if ((byte & CONTINUE_BIT) === 0) {
    return { value: decoded, end: offset + index + 1 };
  }
  return readVarint(bytes, offset, index + 1, decoded);
};

const encodeVarint = (value: number): Uint8Array => {
  const rest = value >>> BITS_PER_BYTE;
  const low = value & VALUE_BITS;
  return rest === 0
    ? Uint8Array.of(low)
    : concat([Uint8Array.of(low | CONTINUE_BIT), encodeVarint(rest)]);
};

const encodePacket = (id: number, payload: Uint8Array) => {
  const body = concat([encodeVarint(id), payload]);
  return concat([encodeVarint(body.length), body]);
};

const encodeString = (value: string) => {
  const text = textEncoder.encode(value);
  return concat([encodeVarint(text.length), text]);
};

export const wakingStatus = encodePacket(STATUS_RESPONSE_PACKET, encodeString(WAKING_STATUS));
export const wakingDisconnect = encodePacket(
  LOGIN_DISCONNECT_PACKET,
  encodeString(WAKING_DISCONNECT),
);

const splitPacket = (
  bytes: Uint8Array,
): { readonly id: number; readonly bytes: Uint8Array; readonly rest: Uint8Array } | undefined => {
  const size = readVarint(bytes, 0);
  const end = size === undefined ? undefined : size.end + size.value;
  const complete = size !== undefined && end !== undefined && bytes.length >= end;
  if (!complete) {
    return undefined;
  }
  const id = readVarint(bytes.subarray(size.end, end), 0);
  return id === undefined
    ? undefined
    : { id: id.value, bytes: bytes.subarray(0, end), rest: bytes.subarray(end) };
};

const nextStateOf = (packet: { readonly bytes: Uint8Array }) => {
  const body = packet.bytes.subarray(readVarint(packet.bytes, 0)?.end ?? 0);
  const id = readVarint(body, 0);
  const protocol = id === undefined ? undefined : readVarint(body, id.end);
  const host = protocol === undefined ? undefined : readVarint(body, protocol.end);
  const isHandshake = id?.value === HANDSHAKE_PACKET && host !== undefined;
  return isHandshake ? readVarint(body, host.end + host.value + PORT_BYTES)?.value : undefined;
};

const bytesOf = (chunk: { readonly done: boolean; readonly value?: unknown }) => {
  const isOpenBytes = !chunk.done && chunk.value instanceof Uint8Array;
  return isOpenBytes ? chunk.value : undefined;
};

const readChunk = (reader: {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
}) =>
  Effect.tryPromise({
    try: () => reader.read(),
    catch: (cause) =>
      new ProtocolFailure({ message: `Reading from the player: ${String(cause)}`, cause }),
  }).pipe(
    Effect.flatMap((chunk) => {
      const bytes = bytesOf(chunk);
      return bytes === undefined
        ? Effect.fail(new ProtocolFailure({ message: "The player closed the connection." }))
        : Effect.succeed(bytes);
    }),
  );

const declaredSize = (bytes: Uint8Array) => readVarint(bytes, 0)?.value;

const isOversized = (bytes: Uint8Array) => {
  const size = declaredSize(bytes);
  const declaresTooMuch = size !== undefined && size > MAX_GREETING_BYTES;
  return declaresTooMuch || bytes.length > MAX_GREETING_BYTES + MAX_VARINT_BYTES;
};

export const readPacket = (
  reader: { read(): Promise<{ readonly done: boolean; readonly value?: unknown }> },
  received: Uint8Array,
): Effect.Effect<
  { readonly id: number; readonly bytes: Uint8Array; readonly rest: Uint8Array },
  ProtocolFailure
> => {
  if (isOversized(received)) {
    return Effect.fail(new ProtocolFailure({ message: "The player sent an oversized packet." }));
  }
  const packet = splitPacket(received);
  if (packet !== undefined) {
    return Effect.succeed(packet);
  }
  return readChunk(reader).pipe(
    Effect.flatMap((chunk) => readPacket(reader, concat([received, chunk]))),
  );
};

export const readGreeting = (reader: {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
}) =>
  readPacket(reader, new Uint8Array()).pipe(
    Effect.flatMap((packet) => {
      const nextState = nextStateOf(packet);
      const isMinecraft = nextState !== undefined && MINECRAFT_STATES.has(nextState);
      return isMinecraft
        ? Effect.succeed({
            nextState,
            received: concat([packet.bytes, packet.rest]),
            afterHandshake: packet.rest,
          })
        : Effect.fail(
            new ProtocolFailure({
              message: "The connection did not start with a Minecraft handshake.",
            }),
          );
    }),
  );

export const isStatusRequest = (greeting: { readonly nextState: number }) =>
  greeting.nextState === STATUS_STATE;

export const isPing = (packet: { readonly id: number; readonly bytes: Uint8Array }) =>
  packet.id === PING_PACKET && declaredSize(packet.bytes) === PING_BODY_BYTES;

export const isStatusQuery = (packet: { readonly id: number; readonly bytes: Uint8Array }) =>
  packet.id === STATUS_QUERY_PACKET && declaredSize(packet.bytes) === STATUS_QUERY_BODY_BYTES;
