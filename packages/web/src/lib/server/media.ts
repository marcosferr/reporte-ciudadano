import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { approvedPhotosUnder, setPhotoKeys, withPrefix, type MediaPrefix } from "@rc/core/photos";
import { config } from "./config";

/**
 * Movimientos de fotos entre prefijos del bucket (ver infra/storage.ts). Solo lo que está en public/ se sirve;
 * al sacar algo de ahí se invalida CloudFront para que deje de entregarlo de inmediato.
 */
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});

async function moveObject(from: string, to: string) {
  const bucket = config.mediaBucket;
  if (!bucket || from === to) return;
  await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${encodeURI(from)}`, Key: to }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
}

export async function deleteObjects(keys: (string | null)[]) {
  const bucket = config.mediaBucket;
  if (!bucket) return;
  await Promise.all(keys.filter((k): k is string => !!k).map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
}

/** Mueve la foto y su miniatura a `prefix`; devuelve las keys nuevas. */
export async function movePhoto(photo: { s3_key_public: string | null; s3_key_thumb: string | null }, prefix: MediaPrefix) {
  const publicKey = photo.s3_key_public && withPrefix(photo.s3_key_public, prefix);
  const thumbKey = photo.s3_key_thumb && withPrefix(photo.s3_key_thumb, prefix);
  if (photo.s3_key_public && publicKey) await moveObject(photo.s3_key_public, publicKey);
  if (photo.s3_key_thumb && thumbKey) await moveObject(photo.s3_key_thumb, thumbKey);
  return { publicKey, thumbKey };
}

/** Saca de CloudFront las fotos de un reporte (/media/<reportId>/*). */
export async function invalidateReportMedia(reportId: string) {
  const id = config.cdnDistributionId;
  if (!id) return;
  await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: id,
    InvalidationBatch: { CallerReference: `${reportId}-${Date.now()}`, Paths: { Quantity: 1, Items: [`/media/${reportId}/*`] } },
  }));
}

/** Ocultar un reporte retira sus fotos de public/; republicarlo las devuelve. */
export async function setReportMediaVisible(reportId: string, visible: boolean) {
  const [from, to]: [MediaPrefix, MediaPrefix] = visible ? ["withheld", "public"] : ["public", "withheld"];
  const photos = await approvedPhotosUnder(reportId, from);
  for (const p of photos) {
    const keys = await movePhoto(p, to);
    await setPhotoKeys(p.id, keys.publicKey, keys.thumbKey);
  }
  if (!visible && photos.length) await invalidateReportMedia(reportId);
}

/** Bytes de una versión procesada, para que el staff vea fotos que no son públicas. */
export async function readObject(key: string) {
  const bucket = config.mediaBucket;
  if (!bucket) return undefined;
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return obj.Body?.transformToWebStream();
}
