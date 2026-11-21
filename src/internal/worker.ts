import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  isPing,
  isStatusQuery,
  isStatusRequest,
  ProtocolFailure,
  readGreeting,
  readPacket,
  wakingDisconnect,
  wakingStatus,
} from "./minecraft-protocol.ts";
import { closeSocket, openSocket, relay, writeBytes } from "./relay.ts";
import { serveWorldStorage } from "./world-storage.ts";

const BACKUP_HOSTNAME = "minecraft-world.internal";
const WORLD_NAME = "survival";
const MINECRAFT_PORT = 25_565;
const SOCKET_OPTIONS = { allowHalfOpen: true, secureTransport: "off" } as const;
const INACTIVITY_MINUTES = 20;
const INACTIVITY_TIMEOUT = Duration.minutes(INACTIVITY_MINUTES);
const TERMINATE_SIGNAL = 15;
const CONFIG_KEY = "paper-config";
const READY_TIMEOUT = "5 seconds";
const PING_TIMEOUT = "5 seconds";
const GREETING_TIMEOUT = "10 seconds";
const WRITE_TIMEOUT = "5 seconds";
const STATUS_REQUEST = Uint8Array.fromHex("1300ffffffff0f096c6f63616c686f737463dd010100");

class WorldUnavailable extends Data.TaggedError("WorldUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class PaperStarting extends Data.TaggedError("PaperStarting")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const configurationHash = (image: string, players: string, whitelist: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${image}\n${players}\n${whitelist}`),
      ),
    catch: (cause) =>
      new WorldUnavailable({ message: "Could not read Paper configuration", cause }),
  }).pipe(Effect.map((bytes) => new Uint8Array(bytes).toHex()));

const keepAwake = (container: Container) =>
  Effect.tryPromise({
    try: () => container.setInactivityTimeout(Duration.toMillis(INACTIVITY_TIMEOUT)),
    catch: (cause) =>
      new WorldUnavailable({ message: "Could not set container inactivity timeout", cause }),
  });

const connectToPaper = (container: Container) =>
  openSocket(
    () =>
      container
        .getTcpPort(MINECRAFT_PORT)
        .connect({ hostname: "10.0.0.1", port: MINECRAFT_PORT }, SOCKET_OPTIONS),
    "2 seconds",
  );

const answerStatus = (
  reader: Parameters<typeof readPacket>[0],
  incoming: Socket,
  received: Uint8Array,
  answered = false,
): Effect.Effect<void, Effect.Error<ReturnType<typeof readPacket | typeof writeBytes>>> =>
  readPacket(reader, received).pipe(
    Effect.flatMap((packet) => {
      if (isPing(packet)) {
        return writeBytes(incoming, packet.bytes);
      }
      const isFirstQuery = isStatusQuery(packet) && !answered;
      return isFirstQuery
        ? writeBytes(incoming, wakingStatus).pipe(
            Effect.andThen(answerStatus(reader, incoming, packet.rest, true)),
          )
        : Effect.fail(new ProtocolFailure({ message: "The player sent an unexpected packet." }));
    }),
  );

const answerWhileWaking = (
  reader: Parameters<typeof readPacket>[0],
  incoming: Socket,
  greeting: Effect.Success<ReturnType<typeof readGreeting>>,
) =>
  isStatusRequest(greeting)
    ? answerStatus(reader, incoming, greeting.afterHandshake).pipe(Effect.timeout(PING_TIMEOUT))
    : writeBytes(incoming, wakingDisconnect).pipe(Effect.timeout(WRITE_TIMEOUT));

const probePaper = (socket: Socket) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => {
        const reader = socket.readable.getReader();
        const writer = socket.writable.getWriter();
        return writer
          .write(STATUS_REQUEST)
          .then(() => reader.read())
          .finally(() => {
            reader.releaseLock();
            writer.releaseLock();
          });
      },
      catch: (cause) => new PaperStarting({ message: "Paper status probe failed", cause }),
    });
    if (response.done) {
      return yield* new PaperStarting({ message: "Paper closed the status connection" });
    }
  }).pipe(Effect.ensuring(closeSocket(socket)));

export class WorldStorage extends WorkerEntrypoint<{ backups: R2Bucket }> {
  public override fetch(request: Request): Promise<Response> {
    return serveWorldStorage(this.env.backups, request);
  }
}

export class MinecraftWorld extends DurableObject<{
  eula: string;
  players: string;
  whitelist?: string;
}> {
  private stopping = false;

  private startPaper() {
    const container = this.ctx.container;
    const environment = this.env;
    const whitelist = environment.whitelist ?? "true";
    const players = whitelist === "true" ? environment.players : "";
    const storage = this.ctx.exports.WorldStorage;
    const state = this.ctx.storage;
    const markStarted = () => {
      this.stopping = false;
    };

    return Effect.gen(function* () {
      if (!container) {
        return yield* new WorldUnavailable({ message: "Minecraft container binding is missing" });
      }
      if (environment.eula !== "true") {
        return yield* new WorldUnavailable({
          message: "MINECRAFT_EULA must be true to start Paper",
        });
      }
      const needsStart = () => !container.running;
      if (needsStart()) {
        const image = container.images["paper"];
        if (image === undefined) {
          return yield* new WorldUnavailable({ message: "Paper container image is missing" });
        }
        const configuration = yield* configurationHash(image, players, whitelist);
        yield* Effect.tryPromise({
          try: () => container.interceptOutboundHttp(BACKUP_HOSTNAME, storage),
          catch: (cause) =>
            new WorldUnavailable({ message: "Could not attach world storage", cause }),
        });

        yield* Effect.tryPromise({
          try: () => {
            if (!needsStart()) {
              return Promise.resolve();
            }
            markStarted();
            container.start({
              image,
              instance: "standard-2",
              enableInternet: true,
              env: {
                WORLD_BACKUP_URL: `http://${BACKUP_HOSTNAME}/world`,
                MINECRAFT_EULA: environment.eula,
                MINECRAFT_PLAYERS: players,
                MINECRAFT_WHITELIST: whitelist,
              },
            });
            return state.put(CONFIG_KEY, configuration);
          },
          catch: (cause) => new WorldUnavailable({ message: "Could not start Paper", cause }),
        });
      }

      yield* keepAwake(container);
      return container;
    });
  }

  private openReadyPaper() {
    return this.stopOutdatedPaper().pipe(
      Effect.flatMap((outdated): Effect.Effect<Container, PaperStarting | WorldUnavailable> =>
        outdated
          ? Effect.fail(new PaperStarting({ message: "Paper is restarting with new settings" }))
          : this.startPaper(),
      ),
      Effect.flatMap((container) =>
        connectToPaper(container).pipe(
          Effect.flatMap((socket) => probePaper(socket)),
          Effect.timeout(READY_TIMEOUT),
          Effect.andThen(connectToPaper(container)),
        ),
      ),
    );
  }

  private stopOutdatedPaper() {
    const container = this.ctx.container;
    const environment = this.env;
    const whitelist = environment.whitelist ?? "true";
    const players = whitelist === "true" ? environment.players : "";
    const state = this.ctx.storage;
    const canInspect = container !== undefined && container.running && environment.eula === "true";
    if (!canInspect) {
      return Effect.succeed(false);
    }
    const markStopping = Effect.sync(() => {
      const alreadyStopping = this.stopping;
      this.stopping = true;
      return alreadyStopping;
    });
    const clearStopping = Effect.sync(() => {
      this.stopping = false;
    });

    return Effect.gen(function* () {
      const image = container.images["paper"];
      if (image === undefined) {
        return yield* new WorldUnavailable({ message: "Paper container image is missing" });
      }
      const configuration = yield* configurationHash(image, players, whitelist);
      const current = yield* Effect.tryPromise({
        try: () => state.get<string>(CONFIG_KEY),
        catch: (cause) =>
          new WorldUnavailable({
            message: "Could not read the running Paper configuration",
            cause,
          }),
      });
      const outdated = container.running && current !== configuration;
      const alreadyStopping = outdated ? yield* markStopping : true;
      if (!alreadyStopping) {
        yield* Effect.logInfo("Restarting Paper to apply the updated configuration.");
        yield* keepAwake(container).pipe(
          Effect.andThen(
            Effect.try({
              try: () => {
                container.signal(TERMINATE_SIGNAL);
              },
              catch: (cause) => new WorldUnavailable({ message: "Could not stop Paper", cause }),
            }),
          ),
          Effect.onError(() => clearStopping),
        );
      }
      return outdated;
    });
  }

  public checkIn(): Promise<void> {
    const container = this.ctx.container;
    const isAwake = container?.running === true;
    if (!isAwake) {
      return Promise.resolve();
    }
    return Effect.runPromise(
      keepAwake(container).pipe(
        Effect.andThen(Effect.logInfo(`Kept Paper awake for ${INACTIVITY_MINUTES} more minutes.`)),
        Effect.andThen(this.stopOutdatedPaper()),
        Effect.asVoid,
      ),
    );
  }

  public override connect(incoming: Socket): Promise<void> {
    const readyPaper = this.openReadyPaper();
    const reader = incoming.readable.getReader();
    return Effect.runPromise(
      readGreeting(reader).pipe(
        Effect.timeout(GREETING_TIMEOUT),
        Effect.flatMap((greeting) =>
          readyPaper.pipe(
            Effect.matchEffect({
              onSuccess: (outgoing) =>
                Effect.sync(() => {
                  reader.releaseLock();
                }).pipe(
                  Effect.andThen(writeBytes(outgoing, greeting.received)),
                  Effect.timeout(WRITE_TIMEOUT),
                  Effect.onError(() => closeSocket(outgoing)),
                  Effect.andThen(relay(incoming, outgoing)),
                ),
              onFailure: (error) =>
                (error instanceof WorldUnavailable
                  ? Effect.logError(`Paper cannot start. ${error.message}`, error.cause)
                  : Effect.logDebug(`Paper is not ready. ${error.message}`)
                ).pipe(Effect.andThen(answerWhileWaking(reader, incoming, greeting))),
            }),
          ),
        ),
        Effect.catchTags({
          ProtocolFailure: (error) => Effect.logDebug(error.message),
          SocketFailure: (error) => Effect.logDebug(error.message),
          TimeoutError: (error) => Effect.logDebug(`The player was too slow. ${error.message}`),
        }),
        Effect.ensuring(closeSocket(incoming)),
      ),
    );
  }
}

const worker = {
  scheduled(
    _controller: ScheduledController,
    environment: { eula: string; minecraft: DurableObjectNamespace<MinecraftWorld> },
  ): Promise<void> | undefined {
    if (environment.eula !== "true") {
      return undefined;
    }
    return environment.minecraft.getByName(WORLD_NAME).checkIn();
  },

  connect(incoming: Socket, environment: { minecraft: DurableObjectNamespace<MinecraftWorld> }) {
    return Effect.runPromise(
      openSocket(
        () =>
          environment.minecraft
            .getByName(WORLD_NAME)
            .connect({ hostname: "minecraft", port: MINECRAFT_PORT }, SOCKET_OPTIONS),
        "15 seconds",
      ).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? closeSocket(incoming) : Effect.void)),
        Effect.flatMap((outgoing) => relay(incoming, outgoing)),
      ),
    );
  },
};

export default worker;
