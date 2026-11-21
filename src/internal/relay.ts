import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

class SocketFailure extends Data.TaggedError("SocketFailure")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const CLOSE_TIMEOUT = "5 seconds";

export const closeSocket = (socket: Socket) =>
  Effect.tryPromise({
    try: () => socket.close(),
    catch: (cause) => new SocketFailure({ cause, message: `Closing socket: ${String(cause)}` }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: CLOSE_TIMEOUT,
      orElse: () => Effect.logDebug("The socket did not close in time."),
    }),
    Effect.catchTag("SocketFailure", (error) => Effect.logDebug(error.message)),
  );

export const openSocket = (connect: () => Socket, deadline: Duration.Input) =>
  Effect.try({
    try: connect,
    catch: (cause) => new SocketFailure({ cause, message: `Connecting socket: ${String(cause)}` }),
  }).pipe(
    Effect.tap((socket) =>
      Effect.tryPromise({
        try: () => socket.opened,
        catch: (cause) => new SocketFailure({ cause, message: `Opening socket: ${String(cause)}` }),
      }).pipe(
        Effect.timeout(deadline),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? closeSocket(socket) : Effect.void)),
      ),
    ),
  );

export const writeBytes = (socket: Socket, bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => {
      const writer = socket.writable.getWriter();
      return writer.write(bytes).finally(() => {
        writer.releaseLock();
      });
    },
    catch: (cause) => new SocketFailure({ cause, message: `Writing to socket: ${String(cause)}` }),
  });

export const relay = (incoming: Socket, outgoing: Socket) =>
  Effect.tryPromise({
    try: () =>
      Promise.all([
        incoming.readable.pipeTo(outgoing.writable),
        outgoing.readable.pipeTo(incoming.writable),
      ]),
    catch: (cause) => new SocketFailure({ cause, message: `Relaying TCP: ${String(cause)}` }),
  }).pipe(
    Effect.catchTag("SocketFailure", (error) => Effect.logDebug(error.message)),
    Effect.ensuring(Effect.all([closeSocket(incoming), closeSocket(outgoing)], { concurrency: 2 })),
    Effect.asVoid,
  );
