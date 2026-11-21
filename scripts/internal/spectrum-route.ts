import * as Cloudflare from "@alchemy.run/cloudflare";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Dns from "@distilled.cloud/cloudflare/dns";
import * as Spectrum from "@distilled.cloud/cloudflare/spectrum";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { ConfigError } from "effect/Config";
import { SourceError } from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const TYPE = "Minecraft.SpectrumRoute";
const PROTOCOL = "tcp/25565";

const CloudflareIdentifier = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/iu));
const RouteTarget = Schema.Struct({
  zoneId: CloudflareIdentifier,
  hostname: Schema.String,
  workerId: CloudflareIdentifier,
});

class SpectrumHostnameInUse extends Data.TaggedError("SpectrumHostnameInUse")<{
  readonly message: string;
}> {}

const ResolvedZone = Schema.Struct({ zoneId: CloudflareIdentifier });
const RouteState = Schema.Struct({
  zoneId: CloudflareIdentifier,
  appId: CloudflareIdentifier,
  hostname: Schema.UndefinedOr(Schema.String),
  workerId: Schema.UndefinedOr(Schema.String),
  trafficType: Schema.UndefinedOr(Schema.String),
  protocol: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});
const RouteResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Int, message: Schema.String })),
  result: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        dns: Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
        origin_worker_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        traffic_type: Schema.optionalKey(Schema.String),
        protocol: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
      }),
    ),
  ),
});
const APP_NOT_FOUND = 10_006;

class SpectrumReadFailed extends Data.TaggedError("SpectrumReadFailed")<{
  readonly message: string;
}> {}

export const SpectrumRoute =
  Resource<Resource<typeof TYPE, typeof RouteTarget.Type, typeof RouteState.Type>>(TYPE);

const readRoute = (route: typeof RouteState.Type) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const credentials = yield* yield* Credentials;
    const response = yield* client.get(
      `${credentials.apiBaseUrl}/zones/${route.zoneId}/spectrum/apps/${route.appId}`,
      { headers: formatHeaders(credentials) },
    );
    const payload = yield* Schema.decodeUnknownEffect(RouteResponse)(yield* response.json);
    if (payload.errors.some(({ code }) => code === APP_NOT_FOUND)) {
      return;
    }
    const { result } = payload;
    const invalid = !payload.success || result === null || result === undefined;
    if (invalid) {
      return yield* new SpectrumReadFailed({
        message: `Cloudflare could not read ${route.hostname ?? route.appId}. ${payload.errors.map(({ message }) => message).join(" ")}`,
      });
    }
    return {
      zoneId: route.zoneId,
      appId: result.id,
      hostname: result.dns.name ?? undefined,
      workerId: result.origin_worker_id ?? undefined,
      trafficType: result.traffic_type,
      protocol: result.protocol,
    };
  });

const findApps = ({ zoneId, hostname }: typeof RouteTarget.Type) =>
  Spectrum.listApps.items({ zoneId }).pipe(
    Stream.filter((app) => app.dns.name === hostname),
    Stream.runCollect,
  );

const isExactRoute = (
  route: typeof RouteState.Type | undefined,
  desired: typeof RouteTarget.Type,
) =>
  route?.hostname === desired.hostname &&
  route.workerId === desired.workerId &&
  route.trafficType === "worker" &&
  route.protocol === PROTOCOL;

const adoptOwnApp = (desired: typeof RouteTarget.Type) =>
  Spectrum.listApps.items({ zoneId: desired.zoneId }).pipe(
    Stream.filter((app) => app.dns.name === desired.hostname),
    Stream.mapEffect((app) =>
      readRoute({
        zoneId: desired.zoneId,
        appId: app.id,
        hostname: desired.hostname,
        workerId: undefined,
        trafficType: undefined,
      }),
    ),
    Stream.filter((route) => isExactRoute(route, desired)),
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([route]) => route),
  );

const ensureHostnameAvailable = (desired: typeof RouteTarget.Type) =>
  Effect.gen(function* () {
    const { zoneId, hostname } = desired;
    const records = yield* Dns.listRecords({ zoneId, name: { exact: hostname }, perPage: 1 });
    const existingApps = yield* findApps(desired);
    const inUse = records.result.length > 0 || existingApps.length > 0;
    if (inUse) {
      return yield* new SpectrumHostnameInUse({
        message: `Choose an unused hostname. ${hostname} already has a DNS record or Spectrum application.`,
      });
    }
  });

export const spectrumRouteProvider = Provider.succeed(SpectrumRoute, {
  stables: ["appId", "zoneId"],
  diff: ({ olds, news }) => {
    const newZone = Option.getOrUndefined(Schema.decodeUnknownOption(ResolvedZone)(news))?.zoneId;
    const changedZone =
      newZone !== undefined && typeof olds.zoneId === "string" && olds.zoneId !== newZone;
    return Effect.succeed({ action: changedZone ? "replace" : "update" } as const);
  },
  read: ({ output }) => (output === undefined ? Effect.undefined : readRoute(output)),
  reconcile: Effect.fn(function* ({ news, output }) {
    const desired = yield* Schema.decodeEffect(RouteTarget)(news);
    const isRecordedInZone = output?.zoneId === desired.zoneId;
    const recorded = isRecordedInZone ? yield* readRoute(output) : undefined;
    const current = recorded ?? (yield* adoptOwnApp(desired));
    const unchanged = isExactRoute(current, desired) ? current : undefined;
    if (unchanged !== undefined) {
      return unchanged;
    }
    if (current?.hostname !== desired.hostname) {
      yield* ensureHostnameAvailable(desired);
    }
    const request = {
      zoneId: desired.zoneId,
      dns: { name: desired.hostname, type: "CNAME" },
      protocol: PROTOCOL,
      trafficType: "worker",
      originWorkerId: desired.workerId,
    } as const;
    const app =
      current === undefined
        ? yield* Spectrum.createApp(request)
        : yield* Spectrum.updateApp({ ...request, appId: current.appId });
    return yield* Schema.decodeEffect(RouteState)({
      ...desired,
      appId: app.id,
      trafficType: "worker",
      protocol: PROTOCOL,
    });
  }),
  delete: ({ output }) =>
    Spectrum.deleteApp({ zoneId: output.zoneId, appId: output.appId }).pipe(
      Effect.catchTag("SpectrumAppNotFound", () => Effect.void),
      Effect.asVoid,
    ),
});

export const spectrumZone = (hostname: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    return yield* Cloudflare.Zone.resolveZoneId({ accountId, hostname, zone: undefined }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError(
            new SourceError({
              message: `Could not resolve the Cloudflare zone for ${hostname}. ${String(cause)}`,
              cause,
            }),
          ),
      ),
    );
  });
