import { Effect } from "effect";
import { range } from "effect/Array";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Stream from "effect/Stream";

import { createArchive, extractArchive, listArchive } from "./paper-commands.ts";
import { withSavingPaused } from "./paper-console.ts";

const WORLD_DIRECTORY = /^world(?:_[^/]+)?$/u;
const LEVEL_FILE = "world/level.dat";
const WHITELIST_FILE = "whitelist.json";
const MAIN_WORLD = "world";
const PART_BYTES = 16_777_216;
const REQUEST_TIMEOUT = "60 seconds";
const NOT_FOUND = 404;

export class CheckpointFailed extends Data.TaggedError("CheckpointFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const failWith = (message: string) => (cause: Error) =>
  new CheckpointFailed({ message: `${message} ${cause.message}`, cause });

const responseText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.execute(request);
    return yield* response.text;
  }).pipe(Effect.timeout(REQUEST_TIMEOUT));

const uploadParts = (storage: string, archive: string, upload: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { size } = yield* fileSystem.stat(archive);
    const partNumbers = range(1, Math.max(1, Math.ceil(Number(size) / PART_BYTES)));
    const parts = yield* Effect.forEach(partNumbers, (partNumber) =>
      fileSystem
        .stream(archive, { offset: (partNumber - 1) * PART_BYTES, bytesToRead: PART_BYTES })
        .pipe(
          Stream.runCollect,
          Effect.map((chunks) => new Uint8Array(Bun.concatArrayBuffers([...chunks]))),
          Effect.map((bytes) =>
            HttpClientRequest.put(storage).pipe(
              HttpClientRequest.setUrlParams({ upload, part: String(partNumber) }),
              HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
            ),
          ),
          Effect.flatMap((request) => responseText(request)),
          Effect.map((etag) => ({ partNumber, etag })),
        ),
    );
    const complete = yield* HttpClientRequest.post(storage).pipe(
      HttpClientRequest.setUrlParams({ upload }),
      HttpClientRequest.bodyJson(parts),
    );
    yield* responseText(complete);
  });

const uploadCheckpoint = (storage: string, archive: string) =>
  Effect.gen(function* () {
    const upload = yield* responseText(HttpClientRequest.post(storage));
    const abort = responseText(
      HttpClientRequest.delete(storage).pipe(HttpClientRequest.setUrlParams({ upload })),
    ).pipe(
      Effect.mapError(failWith("Could not abort the incomplete world checkpoint.")),
      Effect.catchTag("CheckpointFailed", (error) => Effect.logError(error.message)),
    );
    yield* uploadParts(storage, archive, upload).pipe(Effect.onError(() => abort));
  }).pipe(Effect.mapError(failWith("Could not upload the world checkpoint to R2.")));

const downloadCheckpoint = (storage: string, archive: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const response = yield* client.get(storage);
    if (response.status === NOT_FOUND) {
      return false;
    }
    const found = yield* HttpClientResponse.filterStatusOk(response);
    yield* found.stream.pipe(Stream.run(fileSystem.sink(archive)));
    return true;
  }).pipe(Effect.mapError(failWith("Could not download the world checkpoint from R2.")));

const isWorldEntry = (name: string, detail: string) => {
  const parts = name.split("/").filter((part) => part !== "");
  const [top] = parts;
  const isKnownTop = top !== undefined && WORLD_DIRECTORY.test(top);
  const kind = detail.charAt(0);
  const isPlain = kind === "-" || kind === "d";
  const isDirectoryWhenTop = parts.length > 1 || kind === "d";
  const isWhitelist = name === WHITELIST_FILE && kind === "-";
  return isWhitelist || (isKnownTop && isPlain && isDirectoryWhenTop && !parts.includes(".."));
};

const isFile = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(path))) {
      return false;
    }
    const { type } = yield* fileSystem.stat(path);
    return type === "File";
  });

const checkArchive = (archive: string) =>
  Effect.gen(function* () {
    const { names, details } = yield* listArchive(archive);
    const unexpected = names.find((name, index) => !isWorldEntry(name, details[index] ?? ""));
    const isUnreadable = names.length !== details.length;
    const isUnsafe = unexpected !== undefined || isUnreadable;
    if (isUnsafe) {
      return yield* new CheckpointFailed({
        message: `The world checkpoint holds an unexpected entry: ${unexpected ?? "(unreadable listing)"}.`,
      });
    }
    if (!names.includes(LEVEL_FILE)) {
      return yield* new CheckpointFailed({ message: `The world checkpoint has no ${LEVEL_FILE}.` });
    }
  });

const existingDirectories = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const names = yield* fileSystem.readDirectory(root === "" ? "." : root);
    const found = yield* Effect.forEach(
      names.filter((name) => WORLD_DIRECTORY.test(name)),
      (name) =>
        fileSystem
          .stat(`${root}${name}`)
          .pipe(Effect.map(({ type }) => (type === "Directory" ? [name] : []))),
    );
    const directories = found.flat();
    const others = directories.filter((name) => name !== MAIN_WORLD).toSorted();
    return directories.includes(MAIN_WORLD) ? [...others, MAIN_WORLD] : others;
  });

export const restoreWorld = (storage: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* isFile(LEVEL_FILE)) {
      return;
    }
    const staging = yield* fileSystem.makeTempDirectoryScoped({ directory: "." });
    const archive = `${staging}/backup.tar.gz`;
    if (!(yield* downloadCheckpoint(storage, archive))) {
      yield* Effect.logInfo("No saved world in R2. Starting a new world.");
      return;
    }
    yield* checkArchive(archive);
    yield* extractArchive(archive, staging);
    if (!(yield* isFile(`${staging}/${LEVEL_FILE}`))) {
      return yield* new CheckpointFailed({ message: `The world checkpoint has no ${LEVEL_FILE}.` });
    }
    if (yield* isFile(`${staging}/${WHITELIST_FILE}`)) {
      yield* fileSystem.rename(`${staging}/${WHITELIST_FILE}`, WHITELIST_FILE);
    }
    const restored = yield* existingDirectories(`${staging}/`);
    yield* Effect.forEach(restored, (directory) =>
      fileSystem
        .remove(directory, { recursive: true, force: true })
        .pipe(Effect.andThen(fileSystem.rename(`${staging}/${directory}`, directory))),
    );
    yield* Effect.logInfo("Restored the world from R2.");
  }).pipe(Effect.scoped, Effect.mapError(failWith("Could not restore the world.")));

export const saveCheckpoint = (storage: string, consolePassword?: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* isFile(LEVEL_FILE))) {
      return yield* new CheckpointFailed({ message: `There is no ${LEVEL_FILE} to save.` });
    }
    const staging = yield* fileSystem.makeTempDirectoryScoped({ directory: "." });
    const archive = `${staging}/world.tar.gz`;
    const whitelist = (yield* isFile(WHITELIST_FILE)) ? [WHITELIST_FILE] : [];
    const archiveWorld = existingDirectories("").pipe(
      Effect.flatMap((directories) => createArchive(archive, [...directories, ...whitelist])),
    );
    yield* consolePassword === undefined
      ? archiveWorld
      : withSavingPaused(consolePassword, archiveWorld);
    yield* checkArchive(archive);
    yield* uploadCheckpoint(storage, archive);
    yield* Effect.logInfo("Saved a world checkpoint to R2.");
  }).pipe(Effect.scoped, Effect.mapError(failWith("World checkpoint failed.")));
