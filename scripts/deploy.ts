import * as BunServices from "@effect/platform-bun/BunServices";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";

import { runAlchemy, STACK_ENTRYPOINT } from "./internal/alchemy-command.ts";
import { acceptedEula, minecraftWhitelist, playerList } from "./internal/minecraft-config.ts";

export default Effect.runPromise(
  Effect.provide(
    Command.make(
      "deploy",
      {
        stage: Flag.String("stage").pipe(
          Flag.withDefault("production"),
          Flag.withDescription("Alchemy stage to target."),
        ),
        profile: Flag.String("profile").pipe(
          Flag.withDefault("default"),
          Flag.withDescription("Cloudflare credentials profile."),
        ),
        dryRun: Flag.Boolean("dry-run").pipe(
          Flag.withDefault(false),
          Flag.withDescription("Preview the infrastructure changes without applying them."),
        ),
        yes: Flag.Boolean("yes").pipe(
          Flag.withDefault(false),
          Flag.withDescription("Apply without an interactive prompt."),
        ),
      },
      ({ stage, profile, dryRun, yes }) =>
        Effect.gen(function* () {
          const eula = yield* acceptedEula;
          const whitelist = yield* minecraftWhitelist;
          const players = whitelist === "true" ? yield* playerList : "";
          const nobodyAllowed = whitelist === "true" && players.trim() === "";
          if (nobodyAllowed) {
            yield* Effect.logWarning(
              "MINECRAFT_PLAYERS is empty, so nobody can join until you add players and deploy again.",
            );
          }
          yield* Effect.logInfo(
            dryRun
              ? `Previewing the Minecraft deployment for ${stage} with profile ${profile}.`
              : `Deploying the Worker, Paper container, and R2 backups to ${stage} with profile ${profile}.`,
          );
          if (!dryRun) {
            yield* Effect.logInfo(
              "Cloudflare bills for the container while it is awake. It sleeps after 10 minutes with nobody online.",
            );
          }
          const skipConfirmation = yes && !dryRun;
          yield* runAlchemy(
            [
              dryRun ? "plan" : "deploy",
              "--stage",
              stage,
              "--profile",
              profile,
              ...(skipConfirmation ? ["--yes"] : []),
              STACK_ENTRYPOINT,
            ],
            { MINECRAFT_EULA: eula, MINECRAFT_PLAYERS: players, MINECRAFT_WHITELIST: whitelist },
          );
        }),
    ).pipe(
      Command.withDescription("Plan or deploy the Minecraft stack with Alchemy."),
      Command.run({ version: "0.1.0" }),
    ),
    BunServices.layer,
  ),
);
