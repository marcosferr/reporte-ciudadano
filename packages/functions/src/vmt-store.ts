/** Lectura y escritura del histórico del VMT en S3 (prefijo vmt/ del bucket Media, ver @rc/core/vmt-history). */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gunzipSync, gzipSync } from "node:zlib";

const s3 = new S3Client({});
const bucket = () => process.env.MEDIA_BUCKET!;

export async function putJsonGz(key: string, value: unknown) {
  const body = gzipSync(JSON.stringify(value));
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: "application/json", ContentEncoding: "gzip" }));
  return body.length;
}

export async function getJsonGz<T>(key: string): Promise<T> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return JSON.parse(gunzipSync(await obj.Body!.transformToByteArray()).toString("utf8")) as T;
}

export async function putParquet(key: string, body: ArrayBuffer) {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: new Uint8Array(body), ContentType: "application/vnd.apache.parquet" }));
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}
