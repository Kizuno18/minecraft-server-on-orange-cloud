import { fileURLToPath } from "node:url";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  minecraftWhitelist,
  spectrumHostname,
  stackEula,
  stackPlayers,
} from "./internal/minecraft-config.ts";
import { paperBuild } from "./internal/paper-build.ts";
import { SpectrumRoute, spectrumRouteProvider, spectrumZone } from "./internal/spectrum-route.ts";

export default Alchemy.Stack(
  "MinecraftServerOnOrangeCloud",
  {
    providers: spectrumRouteProvider.pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backups = Cloudflare.R2.Bucket("WorldBackups").pipe(RemovalPolicy.retain());
    const build = yield* paperBuild;
    const paper = Cloudflare.Container("paper", {
      context: ".",
      dockerfile: "./Dockerfile",
      ...(build === undefined ? {} : { build }),
      schedulingPolicy: "durable_object",
    });

    const worker = Cloudflare.Worker("Minecraft", {
      main: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      compatibility: { date: "2026-11-20" },
      workersDev: false,
      crons: ["* * * * *"],
      observability: { enabled: true },
      env: {
        minecraft: Cloudflare.DurableObject("MinecraftWorld", { containers: [paper] }),
        backups,
        players: stackPlayers,
        whitelist: minecraftWhitelist,
        eula: stackEula,
      },
    });

    const deployed = yield* worker;
    const bucket = yield* backups;
    const { dev } = yield* Alchemy.AlchemyContext;
    const hostname = dev ? "" : yield* spectrumHostname;
    if (hostname !== "") {
      const zoneId = yield* spectrumZone(hostname);
      yield* SpectrumRoute("MinecraftHostname", { hostname, zoneId, workerId: deployed.workerId });
    }
    return {
      ...(hostname === "" ? {} : { minecraftHostname: hostname }),
      workerName: deployed.workerName,
      workerTag: deployed.workerId,
      backupBucket: bucket.bucketName,
    };
  }),
);
