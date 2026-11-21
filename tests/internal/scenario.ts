import { fileURLToPath } from "node:url";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Task } from "@sshkeda/task";
import { CliError } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Unstable_RawConfig } from "wrangler";

import { dockerConnection, minecraftEula } from "../../scripts/internal/minecraft-config.ts";
import { expectPaperStatus, expectWakingStatus } from "./minecraft-status.ts";

const HOST = "127.0.0.1";
const HTTP_PORT = 8789;
const HTTP_URL = `http://${HOST}:${HTTP_PORT}`;
const MINECRAFT_PORT = 25_567;
const wranglerConfig = {
  name: "minecraft-local-e2e",
  main: fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
  compatibility_date: "2026-11-20",
  workers_dev: false,
  dev: { ip: HOST },
  connect: [{ protocol: "tcp", port: MINECRAFT_PORT }],
  vars: { players: "" },
  r2_buckets: [{ binding: "backups", bucket_name: "minecraft-local-e2e" }],
  durable_objects: { bindings: [{ name: "minecraft", class_name: "MinecraftWorld" }] },
  exports: { MinecraftWorld: { type: "durable-object", storage: "sqlite" } },
  containers: [
    {
      class_name: "MinecraftWorld",
      scheduling_policy: "durable_object",
      images: {
        paper: {
          dockerfile: fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
          build_context: fileURLToPath(new URL("../../", import.meta.url)),
        },
      },
    },
  ],
} satisfies Unstable_RawConfig;

const WORLD_CONTAINERS = "name=minecraft-local-e2e-MinecraftWorld-";
const MARKER = "/data/world/e2e-restore-marker.txt";
const MARKER_CONTENTS = "Restored from the previous container";

const CHECK_IN_LOG = "Kept Paper awake";

const runDocker = (...argumentsList: string[]) =>
  Effect.gen(function* () {
    const connection = yield* dockerConnection;
    const output = yield* Task.exec("docker", argumentsList, { env: connection });
    return output.trim();
  });

const activeWorlds = runDocker(
  "ps",
  "--filter",
  WORLD_CONTAINERS,
  "--format",
  "{{.ID}} {{.Names}}",
).pipe(
  Effect.map((output) =>
    output.split("\n").flatMap((line) => {
      const [id, name] = line.split(" ");
      const isWorld = id !== undefined && name !== undefined && !name.endsWith("-proxy");
      return isWorld ? [id] : [];
    }),
  ),
);

const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new CliError.UserError({ cause: message }));

const firstWorld = (worlds: readonly string[]) => {
  const [world] = worlds;
  const exactlyOne = world !== undefined && worlds.length === 1;
  return exactlyOne
    ? Effect.succeed(world)
    : Effect.fail(new CliError.UserError({ cause: "Expected one local Paper container." }));
};

const WAKE_TIMEOUT = "3 minutes";
const wakePaper = expectWakingStatus(HOST, MINECRAFT_PORT).pipe(
  Effect.andThen(
    expectPaperStatus(HOST, MINECRAFT_PORT).pipe(
      Effect.retry(Schedule.spaced("1 second")),
      Effect.timeout("2 minutes"),
    ),
  ),
);

const firstStatus = Task.make({
  name: "wake-ping",
  timeout: WAKE_TIMEOUT,
  run: wakePaper,
});

const restoredStatus = Task.make({
  name: "restored-wake-ping",
  timeout: WAKE_TIMEOUT,
  run: wakePaper,
});

const ensureUnoccupied = (port: number) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.listen({
          hostname: HOST,
          port,
          socket: {
            data: (socket) => {
              socket.end();
            },
          },
        }),
      catch: (cause) =>
        new CliError.UserError({
          cause: `Local E2E port ${port} is unavailable. ${String(cause)}`,
        }),
    }),
    () => Effect.void,
    (server) =>
      Effect.sync(() => {
        server.stop(true);
      }),
  );

export const runScenario = Effect.gen(function* () {
  const eula = yield* minecraftEula;
  yield* assert(eula === "true", "Set MINECRAFT_EULA=true after accepting the Minecraft EULA.");

  const filesystem = yield* FileSystem.FileSystem;
  const rawHttp = yield* HttpClient.HttpClient;
  const http = HttpClient.filterStatusOk(rawHttp);
  yield* runDocker("info", "--format", "{{.ServerVersion}}");
  yield* assert(
    (yield* activeWorlds).length === 0,
    "A local Minecraft E2E container is already running.",
  );
  yield* ensureUnoccupied(HTTP_PORT);
  yield* ensureUnoccupied(MINECRAFT_PORT);
  const state = yield* filesystem.makeTempDirectoryScoped({ prefix: "minecraft-e2e-" });
  const configPath = `${state}/wrangler.json`;
  const config = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(wranglerConfig);
  yield* filesystem.writeFileString(configPath, config);
  const worker = yield* ChildProcess.make(
    "node",
    [
      "node_modules/wrangler/wrangler-dist/cli.js",
      "dev",
      "--local",
      "--test-scheduled",
      "--port",
      String(HTTP_PORT),
      "--inspector-port",
      "0",
      "--config",
      configPath,
      "--persist-to",
      state,
      "--var",
      "eula:true",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { WRANGLER_SEND_METRICS: "false" },
      extendEnv: true,
      detached: false,
      forceKillAfter: "30 seconds",
      stdout: "pipe",
      stderr: "inherit",
    },
  ).pipe(Effect.provide(BunServices.layer));
  const workerLines: string[] = [];
  yield* worker.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        workerLines.push(line);
      }).pipe(Effect.andThen(Effect.log(line))),
    ),
    Effect.catchTag("PlatformError", (error) =>
      Effect.logWarning(`Stopped reading Wrangler output. ${error.message}`),
    ),
    Effect.forkScoped,
  );
  const checkInsLogged = () => workerLines.filter((line) => line.includes(CHECK_IN_LOG)).length;

  const exited = worker.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.fail(new CliError.UserError({ cause: `Local Wrangler exited with status ${code}.` })),
    ),
  );
  const ready = http
    .get(`${HTTP_URL}/cdn-cgi/local/explorer/api/local/workers`)
    .pipe(
      Effect.timeout("1 second"),
      Effect.retry(Schedule.spaced("250 millis")),
      Effect.timeout("4 minutes"),
    );
  yield* Effect.raceFirst(ready, exited);

  const checkIn = http
    .get(`${HTTP_URL}/__scheduled?cron=${encodeURIComponent("* * * * *")}`)
    .pipe(Effect.timeout("3 minutes"));
  yield* checkIn;
  yield* assert((yield* activeWorlds).length === 0, "A scheduled check-in woke Paper.");
  yield* firstStatus;
  const first = yield* activeWorlds.pipe(Effect.flatMap((worlds) => firstWorld(worlds)));
  const loggedBefore = checkInsLogged();
  yield* checkIn;
  yield* Effect.suspend(() =>
    assert(checkInsLogged() > loggedBefore, "The scheduled check-in did not reach Paper."),
  ).pipe(Effect.retry(Schedule.spaced("250 millis")), Effect.timeout("10 seconds"));
  const unchanged = yield* activeWorlds.pipe(Effect.flatMap((worlds) => firstWorld(worlds)));
  yield* assert(unchanged === first, "A scheduled check-in restarted healthy Paper.");
  yield* Effect.logInfo(
    "The first status ping answered that Paper was waking, and check-ins left it running.",
  );

  yield* runDocker(
    "exec",
    first,
    "sh",
    "-c",
    'printf "%s" "$1" > "$2"',
    "sh",
    MARKER_CONTENTS,
    MARKER,
  );
  yield* runDocker("kill", "--signal=TERM", first);
  yield* activeWorlds.pipe(
    Effect.flatMap((worlds) => assert(worlds.length === 0, "Paper is still shutting down.")),
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeout("3 minutes"),
  );
  yield* checkIn;
  yield* assert((yield* activeWorlds).length === 0, "A scheduled check-in woke stopped Paper.");
  yield* restoredStatus;
  const restored = yield* activeWorlds.pipe(Effect.flatMap((worlds) => firstWorld(worlds)));
  yield* assert(restored !== first, "Expected a fresh Paper container.");
  yield* assert(
    (yield* runDocker("exec", restored, "cat", MARKER)) === MARKER_CONTENTS,
    "Restored world marker differs.",
  );
  yield* Effect.logInfo("A status ping woke a fresh container, which restored the world from R2.");
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
