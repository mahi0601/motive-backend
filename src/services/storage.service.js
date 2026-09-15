// src/services/storage.service.js
// One save/delete interface, two backends — Cloudflare R2 (S3-compatible)
// when configured, local disk otherwise. Callers never need to know which
// is active. R2 is the production-correct choice: Render's disk is
// ephemeral and wiped on every deploy/restart, so local-disk uploads
// silently vanish there. Local disk stays as the zero-setup dev default.
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const logger = require('../config/logger');

const R2_ENABLED = !!(
  config.r2.accountId &&
  config.r2.accessKeyId &&
  config.r2.secretAccessKey &&
  config.r2.bucket &&
  config.r2.publicUrl
);
exports.isR2Enabled = R2_ENABLED;

const UPLOAD_DIR = 'public/uploads/';
if (!R2_ENABLED) {
  // Gitignored (uploaded content shouldn't be committed), so it doesn't
  // exist on a fresh clone/deploy unless created here.
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

let s3Client;
function getS3Client() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function uniqueName(originalname) {
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(originalname)}`;
}

// `file` is a multer memoryStorage file: { buffer, originalname, mimetype }.
// `protocol`/`host` are only used for the local-disk URL shape (R2 URLs are
// absolute regardless of which host served the upload request).
exports.saveFile = async (file, { protocol, host } = {}) => {
  const key = uniqueName(file.originalname);

  if (R2_ENABLED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.r2.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );
    return { url: `${config.r2.publicUrl.replace(/\/$/, '')}/${key}` };
  }

  fs.writeFileSync(path.join(UPLOAD_DIR, key), file.buffer);
  return { url: `${protocol}://${host}/uploads/${key}` };
};

// Best-effort delete, mirrors the old fire-and-forget disk cleanup — a
// failure here shouldn't fail the request, the DB row is the source of
// truth for "is this attached to anything" and is already gone by the time
// this is called.
exports.deleteFile = async (fileUrl) => {
  if (!fileUrl) return;
  const key = path.basename(new URL(fileUrl).pathname);

  if (R2_ENABLED) {
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await getS3Client().send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
    } catch (err) {
      // Was console-only — an orphaned object silently left in the bucket
      // is exactly the kind of failure that's invisible until someone
      // notices the storage bill, unless it's reported.
      logger.error('R2 delete error', err, { key });
    }
    return;
  }

  fs.unlink(path.join(UPLOAD_DIR, key), () => {});
};
