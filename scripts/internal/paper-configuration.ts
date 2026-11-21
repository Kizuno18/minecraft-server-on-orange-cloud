import { Effect } from "effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const PlayerName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{3,16}$/u));
const MojangProfile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  name: Schema.String,
});
const Whitelist = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ uuid: Schema.String, name: Schema.String })),
);
const LOOKUP_TIMEOUT = "10 seconds";
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_DEADLINE = "1 minute";
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
const NOT_FOUND = 404;
const CONSOLE_FILE_MODE = 0o600;

class MojangUnavailable extends Data.TaggedError("MojangUnavailable")<{
  readonly message: string;
}> {}

const unavailable = (message: string) => Effect.fail(new MojangUnavailable({ message }));

const dashedUuid = (id: string) =>
  id.replace(
    /^(?<timeLow>.{8})(?<timeMid>.{4})(?<timeHigh>.{4})(?<clock>.{4})(?<node>.{12})$/u,
    "$<timeLow>-$<timeMid>-$<timeHigh>-$<clock>-$<node>",
  );

const lookUpPlayer = (name: string) =>
  Effect.gen(function* () {
    const playerName = yield* Schema.decodeEffect(PlayerName)(name);
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(
      `https://api.mojang.com/users/profiles/minecraft/${playerName}`,
    );
    const profile = yield* Schema.decodeUnknownEffect(MojangProfile)(yield* response.json);
    return { uuid: dashedUuid(profile.id), name: profile.name };
  }).pipe(
    Effect.timeout(LOOKUP_TIMEOUT),
    Effect.catchTag("TimeoutError", (error) => unavailable(error.message)),
    Effect.catchReasons("HttpClientError", {
      TransportError: (reason) => unavailable(reason.message),
      StatusCodeError: (reason) => {
        const { status } = reason.response;
        const isTemporary = status === TOO_MANY_REQUESTS || status >= SERVER_ERROR;
        if (status === NOT_FOUND) {
          return Effect.logWarning(`Skipping ${name}: no Minecraft Java account has that name.`);
        }
        return isTemporary ? unavailable(reason.message) : Effect.fail(reason);
      },
    }),
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: LOOKUP_ATTEMPTS,
      while: (error) => error instanceof MojangUnavailable,
    }),
    Effect.timeout(LOOKUP_DEADLINE),
  );

const BUKKIT_CONFIGURATION = ["settings:", "  connection-throttle: -1", ""].join("\n");

const serverProperties = (whitelist: string, consolePassword: string) =>
  [
    "online-mode=true",
    `white-list=${whitelist}`,
    `enforce-whitelist=${whitelist}`,
    "level-name=world",
    "server-port=25565",
    "enable-rcon=true",
    "rcon.port=25575",
    `rcon.password=${consolePassword}`,
    "broadcast-rcon-to-ops=false",
    "view-distance=8",
    "simulation-distance=5",
    "motd=Minecraft Server on Orange Cloud",
    "",
  ].join("\n");

export const writePaperConfiguration = (options: {
  readonly players: string;
  readonly whitelist: string;
  readonly consolePassword: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (options.whitelist === "true") {
      const names = [
        ...new Set(
          options.players
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== ""),
        ),
      ];
      const saved = (yield* fileSystem.exists("whitelist.json"))
        ? yield* fileSystem.readFileString("whitelist.json").pipe(
            Effect.flatMap(Schema.decodeEffect(Whitelist)),
            Effect.catchTags({
              SchemaError: (error) =>
                Effect.logWarning(
                  `Looking up every player again. The saved whitelist is unreadable. ${error.message}`,
                ).pipe(Effect.as([])),
              PlatformError: (error) =>
                Effect.logWarning(
                  `Looking up every player again. Could not read the saved whitelist. ${error.message}`,
                ).pipe(Effect.as([])),
            }),
          )
        : [];
      const savedByName = new Map(saved.map((entry) => [entry.name.toLowerCase(), entry]));
      const found = yield* Effect.forEach(names, (name) => {
        const known = savedByName.get(name.toLowerCase());
        return known === undefined ? lookUpPlayer(name) : Effect.succeed(known);
      });
      const profiles = found.flatMap((profile) => (profile === undefined ? [] : [profile]));
      yield* fileSystem.writeFileString(
        "whitelist.json",
        yield* Schema.encodeEffect(Whitelist)(profiles),
      );
    } else {
      yield* fileSystem.remove("whitelist.json", { force: true });
    }
    yield* fileSystem.writeFileString("eula.txt", "eula=true\n");
    yield* fileSystem.writeFileString("bukkit.yml", BUKKIT_CONFIGURATION);
    yield* fileSystem.writeFileString(
      "server.properties",
      serverProperties(options.whitelist, options.consolePassword),
      { mode: CONSOLE_FILE_MODE },
    );
    yield* fileSystem.chmod("server.properties", CONSOLE_FILE_MODE);
  });
