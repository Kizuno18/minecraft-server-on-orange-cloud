#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FetchHttpClient } from "effect/http";

import { supervisePaper } from "./internal/supervise-paper.ts";

BunRuntime.runMain(
  supervisePaper.pipe(Effect.provide([BunServices.layer, FetchHttpClient.layer])),
  {
    teardown: (exit, onExit) => {
      const stoppedCleanly = Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause);
      onExit(stoppedCleanly ? 0 : 1);
    },
  },
);
