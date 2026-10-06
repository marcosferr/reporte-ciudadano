import { DetectFacesCommand, DetectModerationLabelsCommand, RekognitionClient } from "@aws-sdk/client-rekognition";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { completePhoto, getPhotoByKey } from "@rc/core/photos";
import type { S3Event } from "aws-lambda";
import { blurBoxes, decide, normalize, thumbnail } from "./image";

const s3 = new S3Client({});
const rekognition = new RekognitionClient({});

export async function handler(event: S3Event) {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    await processUpload(key).catch((err) => {
      console.error("moderación falló", key, err);
      throw err; // reintento automático de Lambda
    });
  }
}

async function processUpload(key: string) {
  const photo = await getPhotoByKey(key);
  if (!photo) {
    console.warn("subida sin reserva, se ignora", key);
    return;
  }
  if (photo.status !== "processing") return; // idempotente ante reintentos

  const bucket = process.env.MEDIA_BUCKET!;
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const original = Buffer.from(await obj.Body!.transformToByteArray());

  let normalized;
  try {
    normalized = await normalize(original);
  } catch (err) {
    await completePhoto(photo.id, { status: "rejected", moderation: { error: "imagen inválida" } });
    return;
  }

  const [labels, faces] = await Promise.all([
    rekognition.send(new DetectModerationLabelsCommand({ Image: { Bytes: normalized.data }, MinConfidence: 60 })),
    rekognition.send(new DetectFacesCommand({ Image: { Bytes: normalized.data }, Attributes: ["DEFAULT"] })),
  ]);
  const moderationLabels = labels.ModerationLabels ?? [];
  const status = decide(moderationLabels);
  const boxes = (faces.FaceDetails ?? []).filter((f) => (f.Confidence ?? 0) > 70).map((f) => f.BoundingBox!) as any[];
  const moderation = {
    labels: moderationLabels.map((l) => ({ name: l.Name, parent: l.ParentName, confidence: Math.round(l.Confidence ?? 0) })),
    faces: boxes.length,
  };

  if (status === "rejected") {
    await completePhoto(photo.id, { status, moderation });
    return;
  }

  const blurred = await blurBoxes(normalized.data, normalized.width, normalized.height, boxes);
  const thumb = await thumbnail(blurred);
  // Lo que necesita revisión humana queda fuera de public/ (CloudFront no lo sirve) hasta que un moderador lo apruebe.
  const base = `${status === "review" ? "review" : "public"}/${photo.report_id}/${photo.id}`;
  // Sin "immutable": si un moderador retira la foto, se invalida CloudFront y el navegador la suelta en un día.
  const cache = "public, max-age=86400, s-maxage=31536000";
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${base}.jpg`, Body: blurred, ContentType: "image/jpeg", CacheControl: cache })),
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${base}_t.jpg`, Body: thumb, ContentType: "image/jpeg", CacheControl: cache })),
  ]);
  await completePhoto(photo.id, {
    status,
    publicKey: `${base}.jpg`,
    thumbKey: `${base}_t.jpg`,
    width: normalized.width,
    height: normalized.height,
    moderation,
  });
}
