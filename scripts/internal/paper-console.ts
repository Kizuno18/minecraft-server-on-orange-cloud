import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Rcon } from "rcon-client";

const CONSOLE_PORT = 25_575;
const PLAYER_COUNT = /There are (?<online>\d+)/u;

export class ConsoleFailed extends Data.TaggedError("ConsoleFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const openConsole = (password: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Rcon.connect({ host: "127.0.0.1", port: CONSOLE_PORT, password }),
      catch: (cause) =>
        new ConsoleFailed({ message: `Could not open Paper's console. ${String(cause)}`, cause }),
    }),
    (console) =>
      Effect.tryPromise({
        try: () => console.end(),
        catch: (cause) =>
          new ConsoleFailed({
            message: `Could not close Paper's console. ${String(cause)}`,
            cause,
          }),
      }).pipe(Effect.catchTag("ConsoleFailed", (error) => Effect.logWarning(error.message))),
  );

const sendCommand = (console: Rcon, command: string) =>
  Effect.tryPromise({
    try: () => console.send(command),
    catch: (cause) =>
      new ConsoleFailed({ message: `Paper did not run ${command}. ${String(cause)}`, cause }),
  });

export const playersOnline = (password: string) =>
  Effect.gen(function* () {
    const console = yield* openConsole(password);
    const reply = yield* sendCommand(console, "list");
    const online = PLAYER_COUNT.exec(reply)?.groups?.["online"];
    if (online === undefined) {
      return yield* new ConsoleFailed({
        message: `Could not read the player count from "${reply}".`,
        cause: reply,
      });
    }
    return Number(online);
  }).pipe(Effect.scoped);

export const withSavingPaused = <Value, Failure, Requirements>(
  password: string,
  work: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const console = yield* openConsole(password);
    const run = (command: string) => sendCommand(console, command);
    return yield* run("save-off").pipe(
      Effect.andThen(run("save-all flush")),
      Effect.andThen(work),
      Effect.ensuring(
        run("save-on").pipe(
          Effect.catchTag("ConsoleFailed", (error) => Effect.logError(error.message)),
        ),
      ),
    );
  }).pipe(Effect.scoped);
