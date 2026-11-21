import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const minecraftEula = Config.String("MINECRAFT_EULA");
export const minecraftPlayers = Config.String("MINECRAFT_PLAYERS");
export const acceptedEula = Config.schema(Schema.Literal("true"), "MINECRAFT_EULA");
export const playerList = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^\s*(?:[A-Za-z0-9_]{3,16}\s*(?:,\s*[A-Za-z0-9_]{3,16}\s*)*)?$/u),
  ),
  "MINECRAFT_PLAYERS",
).pipe(Config.withDefault(""));
export const stackEula = minecraftEula.pipe(Config.withDefault("false"));
export const stackPlayers = minecraftPlayers.pipe(Config.withDefault(""));

export const spectrumHostname = Config.String("MINECRAFT_SPECTRUM_HOST").pipe(
  Config.withDefault(""),
  Config.map((hostname) => hostname.trim().toLowerCase().replace(/\.$/u, "")),
);

export const minecraftWhitelist = Config.schema(
  Schema.Literals(["true", "false"]),
  "MINECRAFT_WHITELIST",
).pipe(Config.withDefault("true"));

export const paperSelection = Config.all({
  version: Config.String("MINECRAFT_VERSION").pipe(Config.withDefault("")),
  build: Config.String("MINECRAFT_PAPER_BUILD").pipe(Config.withDefault("")),
});

export const worldBackupUrl = Config.String("WORLD_BACKUP_URL");

const optionalString = (name: string) => Config.option(Config.String(name));

export const dockerConnection = Config.all({
  WRANGLER_DOCKER_HOST: optionalString("WRANGLER_DOCKER_HOST"),
  DOCKER_HOST: optionalString("DOCKER_HOST"),
  DOCKER_CONTEXT: optionalString("DOCKER_CONTEXT"),
  DOCKER_CONFIG: optionalString("DOCKER_CONFIG"),
  DOCKER_CERT_PATH: optionalString("DOCKER_CERT_PATH"),
  DOCKER_TLS_VERIFY: optionalString("DOCKER_TLS_VERIFY"),
}).pipe(
  Config.map(({ WRANGLER_DOCKER_HOST: wranglerHost, ...variables }) =>
    Object.fromEntries([
      ...Object.entries(variables).flatMap(([name, value]) =>
        Option.isSome(value) ? [[name, value.value] as const] : [],
      ),
      ...(Option.isSome(wranglerHost) ? [["DOCKER_HOST", wranglerHost.value] as const] : []),
    ]),
  ),
);
