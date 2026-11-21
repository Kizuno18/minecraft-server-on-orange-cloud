import { Task } from "@sshkeda/task";
import { ProfileStore, ProfileStoreLive } from "alchemy/Auth/Profile";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { STACK_ENTRYPOINT } from "./internal/alchemy-command.ts";

export default Task.make({
  name: "setup-alchemy",
  flags: Schema.Struct({ profile: Schema.optionalKey(Schema.String) }),
  run: ({ profile = "default" }) =>
    Effect.gen(function* () {
      const profiles = yield* ProfileStore;
      const manifest = yield* profiles.readManifest;
      const connected = Object.hasOwn(manifest.profiles[profile]?.providers ?? {}, "Cloudflare");
      yield* Task.exec(
        "bun",
        [
          "alchemy",
          "profile",
          "edit",
          "--profile",
          profile,
          connected ? "--reconfigure" : "--add",
          "Cloudflare",
          "--config",
          STACK_ENTRYPOINT,
        ],
        { stdio: "inherit" },
      );
    }).pipe(Effect.provide(ProfileStoreLive.pipe(Layer.provide(SecureRandom.layerWebCrypto)))),
});
