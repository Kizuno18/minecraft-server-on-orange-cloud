import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { CliError } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Reader, SocketError } from "effect/socket/Socket";

const STATUS_REQUEST = Uint8Array.fromHex("1300ffffffff0f096c6f63616c686f737463dd010100");
const MAX_PACKET_BYTES = 100_000;
const MAX_VARINT_BYTES = 5;
const MORE_BYTES = 0x80;
const VARINT_VALUE_MASK = 0x7f;
const VARINT_BITS_PER_BYTE = 7;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const statusFrom = (versionPrefix: string) =>
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Struct({ name: Schema.String.check(Schema.isStartingWith(versionPrefix)) }),
    }),
  );
const PaperStatus = statusFrom("Paper ");
const WakingStatus = statusFrom("Waking up");

const readVarint = (
  buffer: Uint8Array,
  offset: number,
  index = 0,
  value = 0,
): { value: number; end: number } | undefined => {
  const byte = buffer[offset + index];
  const missing = byte === undefined || index === MAX_VARINT_BYTES;
  if (missing) {
    return;
  }
  const decoded = value | ((byte & VARINT_VALUE_MASK) << (index * VARINT_BITS_PER_BYTE));
  if ((byte & MORE_BYTES) === 0) {
    return { value: decoded, end: offset + index + 1 };
  }
  return readVarint(buffer, offset, index + 1, decoded);
};

const readPacket = (
  reader: Reader,
  buffer: Uint8Array,
): Effect.Effect<Uint8Array, CliError.UserError | SocketError> =>
  Effect.gen(function* () {
    const size = readVarint(buffer, 0);
    if (buffer.length > MAX_PACKET_BYTES) {
      return yield* new CliError.UserError({ cause: "Minecraft status packet is too large." });
    }
    const complete = size !== undefined && buffer.length >= size.end + size.value;
    if (complete) {
      return buffer.subarray(size.end, size.end + size.value);
    }
    const chunks = (yield* reader.pull).map((chunk) =>
      typeof chunk === "string" ? textEncoder.encode(chunk) : chunk,
    );
    const combined = Bun.concatArrayBuffers([buffer, ...chunks], MAX_PACKET_BYTES + 1);
    return yield* readPacket(reader, new Uint8Array(combined));
  });

const expectStatus = (host: string, port: number, expected: typeof PaperStatus) =>
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "5 seconds" });
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(STATUS_REQUEST);

    const packet = yield* readPacket(reader, new Uint8Array());
    const kind = readVarint(packet, 0);
    const status = kind?.value === 0 ? readVarint(packet, kind.end) : undefined;
    const invalid = status?.end === undefined || status.value !== packet.length - status.end;
    if (invalid) {
      return yield* new CliError.UserError({ cause: "Expected a Minecraft status response." });
    }
    yield* Schema.decodeEffect(expected)(textDecoder.decode(packet.subarray(status.end)));
  }).pipe(Effect.scoped);

export const expectPaperStatus = (host: string, port: number) =>
  expectStatus(host, port, PaperStatus);

export const expectWakingStatus = (host: string, port: number) =>
  expectStatus(host, port, WakingStatus);
