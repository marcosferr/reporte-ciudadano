import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { config } from "./config";

const s3 = new S3Client({});
const ses = new SESv2Client({});

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** POST prefirmado: el navegador sube directo a S3 (la Lambda no toca los bytes). */
export async function presignUpload(key: string) {
  const bucket = config.mediaBucket;
  if (!bucket) return null; // dev local sin AWS
  return createPresignedPost(s3, {
    Bucket: bucket,
    Key: key,
    Conditions: [
      ["content-length-range", 1024, MAX_UPLOAD_BYTES],
      ["starts-with", "$Content-Type", "image/"],
    ],
    Fields: { "Content-Type": "image/jpeg" },
    Expires: 600,
  });
}

/** Hay captcha configurado (en local no). */
export function captchaEnabled(): boolean {
  return !!config.turnstileSecret;
}

export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = config.turnstileSecret;
  if (!secret) return true; // captcha desactivado
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success;
}

export async function sendMail(to: string[], subject: string, text: string) {
  if (!to.length) return;
  if (!config.mailFrom) {
    console.log("[mail:dev]", { to, subject, text });
    return;
  }
  // Un correo por destinatario para no exponer direcciones.
  await Promise.allSettled(
    to.map((addr) =>
      ses.send(
        new SendEmailCommand({
          FromEmailAddress: config.mailFrom,
          Destination: { ToAddresses: [addr] },
          Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
        }),
      ),
    ),
  );
}
