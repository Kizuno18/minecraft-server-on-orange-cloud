import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CHECKPOINT = "survival/latest.tar.gz";
const PartNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));
const UploadedParts = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ partNumber: Schema.Int, etag: Schema.String })),
);
const UploadToken = Schema.String.pipe(HttpApiSchema.asText());
const Archive = HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" });
const UploadQuery = { upload: Schema.String };
const UploadErrors = [HttpApiError.BadRequestNoContent, HttpApiError.InternalServerErrorNoContent];

class Backups extends Context.Service<Backups, R2Bucket>()("WorldStorage/Backups") {}

class StorageFailure extends Data.TaggedError("StorageFailure")<{ readonly cause: unknown }> {}

const api = HttpApi.make("WorldStorage").add(
  HttpApiGroup.make("world").add(
    HttpApiEndpoint.get("restore", "/world", {
      success: Archive,
      error: [HttpApiError.NotFoundNoContent, HttpApiError.InternalServerErrorNoContent],
    }),
    HttpApiEndpoint.post("startOrComplete", "/world", {
      query: { upload: Schema.optionalKey(Schema.String) },
      success: [UploadToken, HttpApiSchema.NoContent],
      error: UploadErrors,
    }),
    HttpApiEndpoint.put("uploadPart", "/world", {
      query: { ...UploadQuery, part: PartNumber },
      headers: { "content-length": Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))) },
      payload: Archive,
      success: UploadToken,
      error: UploadErrors,
    }),
    HttpApiEndpoint.delete("abort", "/world", {
      query: UploadQuery,
      success: HttpApiSchema.NoContent,
      error: UploadErrors,
    }),
  ),
);

const useBackups = <Value>(operation: string, run: () => Promise<Value>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StorageFailure({ cause }) }).pipe(
    Effect.tapError(({ cause }) =>
      Effect.logError("World checkpoint storage failed", { operation, cause }),
    ),
    Effect.mapError(() => new HttpApiError.InternalServerError()),
  );

const handlers = HttpApiBuilder.group(api, "world", (group) =>
  group
    .handle("restore", () =>
      Effect.gen(function* () {
        const bucket = yield* Backups;
        const object = yield* useBackups("restore", () => bucket.get(CHECKPOINT));
        if (object === null) {
          return yield* new HttpApiError.NotFound();
        }
        return HttpServerResponse.raw(object.body, { contentType: "application/octet-stream" });
      }),
    )
    .handleRaw("startOrComplete", ({ query, request }) =>
      Effect.gen(function* () {
        const bucket = yield* Backups;
        const { upload } = query;
        if (upload === undefined) {
          const session = yield* useBackups("start upload", () =>
            bucket.createMultipartUpload(CHECKPOINT),
          );
          return session.uploadId;
        }

        const parts = yield* request.text.pipe(
          Effect.flatMap((text) => Schema.decodeEffect(UploadedParts)(text)),
          Effect.mapError(() => new HttpApiError.BadRequest()),
        );
        return yield* useBackups("complete upload", () =>
          bucket.resumeMultipartUpload(CHECKPOINT, upload).complete([...parts]),
        ).pipe(Effect.asVoid);
      }),
    )
    .handleRaw("uploadPart", ({ query, request }) =>
      Effect.gen(function* () {
        const bucket = yield* Backups;
        const originalRequest = yield* HttpServerRequest.toWeb(request).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest()),
        );
        const { body } = originalRequest;
        if (body === null) {
          return yield* new HttpApiError.BadRequest();
        }
        const part = yield* useBackups("upload part", () =>
          bucket.resumeMultipartUpload(CHECKPOINT, query.upload).uploadPart(query.part, body),
        );
        return part.etag;
      }),
    )
    .handle("abort", ({ query }) =>
      Effect.gen(function* () {
        const bucket = yield* Backups;
        yield* useBackups("abort upload", () =>
          bucket.resumeMultipartUpload(CHECKPOINT, query.upload).abort(),
        );
      }),
    ),
);

const webPlatform = Layer.mergeAll(HttpPlatform.layer, Path.layer, Etag.layerWeak).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const { handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(api).pipe(Layer.provide([handlers, webPlatform])),
  { disableLogger: true },
);

export const serveWorldStorage = (bucket: R2Bucket, request: Request): Promise<Response> =>
  handler(request, Context.make(Backups, bucket));
