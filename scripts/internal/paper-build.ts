import { ConfigError } from "effect/Config";
import { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";

import { paperSelection } from "./minecraft-config.ts";

const USER_AGENT =
  "minecraft-server-on-orange-cloud (https://github.com/sshkeda/minecraft-server-on-orange-cloud)";
const PaperSelection = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u)),
  build: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
});
const PaperBuildResponse = Schema.Struct({
  id: Schema.Int,
  channel: Schema.String,
  downloads: Schema.Struct({
    "server:default": Schema.Struct({
      url: Schema.String.check(
        Schema.isPattern(
          /^https:\/\/fill-data\.papermc\.io\/v1\/objects\/[a-f0-9]{64}\/[a-z0-9.-]+\.jar$/u,
        ),
      ),
      checksums: Schema.Struct({
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      }),
    }),
  }),
});

export const paperBuild = Effect.gen(function* () {
  const selection = yield* paperSelection;
  const useDefault = selection.version === "" && selection.build === "";
  if (useDefault) {
    return;
  }

  const { version, build } = yield* Schema.decodeEffect(PaperSelection)(selection).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError(
          new SourceError({
            message: "Set MINECRAFT_VERSION and MINECRAFT_PAPER_BUILD together.",
            cause,
          }),
        ),
    ),
  );
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const metadata = yield* client
    .get(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/${build}`, {
      headers: { "user-agent": USER_AGENT },
    })
    .pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap((data) => Schema.decodeUnknownEffect(PaperBuildResponse)(data)),
      Effect.mapError(
        (cause) =>
          new ConfigError(
            new SourceError({
              message: `Could not look up Paper ${version} build ${build}.`,
              cause,
            }),
          ),
      ),
    );
  const expected = metadata.id === Number(build) && metadata.channel === "STABLE";
  if (!expected) {
    return yield* Effect.fail(
      new ConfigError(
        new SourceError({ message: `Choose a stable Paper build for Minecraft ${version}.` }),
      ),
    );
  }
  const { url, checksums } = metadata.downloads["server:default"];
  return {
    args: {
      PAPER_URL: url,
      PAPER_SHA256: checksums.sha256,
    },
  };
});
