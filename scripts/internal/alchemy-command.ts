import { fileURLToPath } from "node:url";

import { CliError } from "effect/cli";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const STACK_ENTRYPOINT = "scripts/stack.ts";

export const runAlchemy = (
  argumentsList: readonly string[],
  environment?: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("bun", ["alchemy", ...argumentsList], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: environment,
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = yield* spawner.exitCode(command);
    if (exitCode !== 0) {
      return yield* new CliError.UserError({ cause: `Alchemy exited with status ${exitCode}.` });
    }
  });
