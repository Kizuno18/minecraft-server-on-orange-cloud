import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { minecraftWhitelist, stackEula, stackPlayers, worldBackupUrl } from "./minecraft-config.ts";
import { startPaper, stopPaper } from "./paper-commands.ts";
import { writePaperConfiguration } from "./paper-configuration.ts";
import { playersOnline } from "./paper-console.ts";
import { restoreWorld, saveCheckpoint } from "./world-checkpoint.ts";

const CHECKPOINT_INTERVAL = "5 minutes";
const PASSWORD_BYTES = 24;
const IDLE_CHECK_INTERVAL = "1 minute";
const IDLE_CHECKS_BEFORE_SLEEP = 10;
const FINAL_SAVE_RETRIES = 6;
const FINAL_SAVE_DEADLINE = "10 minutes";
const CONSOLE_FAILURES_BEFORE_EXIT = 30;

class PaperFailed extends Data.TaggedError("PaperFailed")<{ readonly message: string }> {}

const waitUntilEmpty = (
  consolePassword: string,
  idleChecks = 0,
  consoleFailures = 0,
): Effect.Effect<void, PaperFailed> =>
  idleChecks >= IDLE_CHECKS_BEFORE_SLEEP
    ? Effect.void
    : Effect.sleep(IDLE_CHECK_INTERVAL).pipe(
        Effect.andThen(playersOnline(consolePassword)),
        Effect.map((online) => ({ idle: online === 0 ? idleChecks + 1 : 0, failures: 0 })),
        Effect.catchTag("ConsoleFailed", (error) =>
          consoleFailures + 1 >= CONSOLE_FAILURES_BEFORE_EXIT
            ? Effect.fail(
                new PaperFailed({
                  message: `Paper's console has not answered for ${CONSOLE_FAILURES_BEFORE_EXIT} minutes. ${error.message}`,
                }),
              )
            : Effect.logWarning(`${error.message} Staying awake.`).pipe(
                Effect.as({ idle: 0, failures: consoleFailures + 1 }),
              ),
        ),
        Effect.flatMap(({ idle, failures }) => waitUntilEmpty(consolePassword, idle, failures)),
      );

export const supervisePaper = Effect.gen(function* () {
  if ((yield* stackEula) !== "true") {
    return yield* new PaperFailed({
      message: "Set MINECRAFT_EULA=true after accepting the Minecraft EULA.",
    });
  }
  const storage = yield* worldBackupUrl;
  yield* restoreWorld(storage);
  const consolePassword = crypto.getRandomValues(new Uint8Array(PASSWORD_BYTES)).toHex();
  yield* writePaperConfiguration({
    players: yield* stackPlayers,
    whitelist: yield* minecraftWhitelist,
    consolePassword,
  });

  const saving = yield* Semaphore.make(1);
  const save = (password?: string) => saving.withPermits(1)(saveCheckpoint(storage, password));

  const paper = yield* Effect.acquireRelease(startPaper, (handle) =>
    stopPaper(handle).pipe(
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? save().pipe(
              Effect.tapError((error) => Effect.logWarning(`${error.message} Retrying.`)),
              Effect.retry({
                schedule: Schedule.exponential("2 seconds"),
                times: FINAL_SAVE_RETRIES,
              }),
              Effect.timeout(FINAL_SAVE_DEADLINE),
              Effect.catchTag("TimeoutError", (error) =>
                Effect.logError(`The final save did not finish. ${error.message}`),
              ),
            )
          : Effect.logWarning(`Paper exited with status ${exitCode}. Skipping the final save.`),
      ),
      Effect.catchTags({
        CheckpointFailed: (error) => Effect.logError(error.message),
        PlatformError: (error) => Effect.logError(`Could not stop Paper. ${error.message}`),
      }),
    ),
  );

  const checkpoints = Effect.sleep(CHECKPOINT_INTERVAL).pipe(
    Effect.andThen(save(consolePassword)),
    Effect.catchTag("CheckpointFailed", (error) => Effect.logError(error.message)),
    Effect.forever,
  );
  const sleepWhenEmpty = waitUntilEmpty(consolePassword).pipe(
    Effect.andThen(save(consolePassword)),
    Effect.andThen(playersOnline(consolePassword)),
    Effect.map((online) => online === 0),
    Effect.catchTags({
      CheckpointFailed: (error) =>
        Effect.logError(`${error.message} Staying awake.`).pipe(Effect.as(false)),
      ConsoleFailed: (error) =>
        Effect.logWarning(`${error.message} Staying awake.`).pipe(Effect.as(false)),
    }),
    Effect.repeat({ until: (saved) => saved }),
    Effect.andThen(Effect.logInfo("Nobody has played for 10 minutes. Going to sleep.")),
    Effect.as(0),
  );
  const exitCode = yield* Effect.raceFirst(
    paper.exitCode,
    Effect.raceFirst(checkpoints, sleepWhenEmpty),
  );
  if (exitCode !== 0) {
    return yield* new PaperFailed({ message: `Paper exited with status ${exitCode}.` });
  }
}).pipe(Effect.scoped);
