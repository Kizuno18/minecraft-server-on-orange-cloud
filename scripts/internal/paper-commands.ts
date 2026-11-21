import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";

const JAVA_ARGUMENTS = [
  "-Xms4G",
  "-Xmx4G",
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:+AlwaysPreTouch",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
  "-Dusing.aikars.flags=https://mcflags.emc.gs",
  "-Daikars.new.flags=true",
  "-jar",
  "/opt/paper.jar",
  "--nogui",
] as const;
const STOP_TIMEOUT = "5 minutes";
const STOP_COMMAND = new TextEncoder().encode("stop\n");

class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
}> {}

const runCommand = (command: string, argumentsList: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, argumentsList, { stdout: "inherit", stderr: "inherit" }),
    );
    if (exitCode !== 0) {
      return yield* new CommandFailed({ message: `${command} exited with status ${exitCode}.` });
    }
  });

const readCommandLines = (command: string, argumentsList: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.lines(ChildProcess.make(command, argumentsList));
  });

export const createArchive = (archive: string, directories: readonly string[]) =>
  runCommand("tar", [
    "--create",
    "--use-compress-program=gzip -3",
    "--exclude=session.lock",
    "--hard-dereference",
    "--file",
    archive,
    ...directories,
  ]);

export const listArchive = (archive: string) =>
  Effect.all({
    names: readCommandLines("tar", ["--list", "--gzip", "--file", archive]),
    details: readCommandLines("tar", ["--list", "--verbose", "--gzip", "--file", archive]),
  });

export const extractArchive = (archive: string, directory: string) =>
  runCommand("tar", [
    "--extract",
    "--gzip",
    "--no-same-owner",
    "--file",
    archive,
    "--directory",
    directory,
  ]);

export const startPaper = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.spawn(
    ChildProcess.make("java", JAVA_ARGUMENTS, {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
});

export const stopPaper = (paper: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    if (yield* paper.isRunning) {
      yield* Stream.make(STOP_COMMAND).pipe(Stream.run(paper.stdin));
    }
    return yield* paper.exitCode.pipe(
      Effect.timeoutOrElse({
        duration: STOP_TIMEOUT,
        orElse: () => paper.kill({ killSignal: "SIGKILL" }).pipe(Effect.andThen(paper.exitCode)),
      }),
    );
  });
