// src/services/storage.service.js
// One save/delete interface, two backends — Cloudflare R2 (S3-compatible)
// when configured, local disk otherwise. Callers never need to know which
// is active. R2 is the production-correct choice: Render's disk is
// ephemeral and wiped on every deploy/restart, so local-disk uploads
// silently vanish there. Local disk stays as the zero-setup dev default.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const logger = require('../config/logger');
const { MIME_BY_EXTENSION, DOWNLOAD_ONLY_EXTENSIONS } = require('../utils/fileTypes');

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

// Uploaded files are served from public URLs (the browser loads them with
// plain <img>/<a>, which can't send credentials cross-origin), so the
// filename is the only thing keeping a file private. It must be unguessable:
// a CSPRNG UUID, not a timestamp plus Math.random().
function uniqueName(originalname) {
  return `${crypto.randomUUID()}${path.extname(originalname).toLowerCase()}`;
}

// `file` is a multer memoryStorage file: { buffer, originalname, mimetype }.
// `mimetype` is deliberately never read here — it's a header the uploading
// client sets and fully controls, not something the server verified. The
// stored Content-Type always comes from MIME_BY_EXTENSION, keyed by the
// extension upload.middleware.js already validated — so `x.png` uploaded
// with `Content-Type: text/html` is still stored (and served back) as
// `image/png`, not HTML.
exports.saveFile = async (file) => {
  const key = uniqueName(file.originalname);
  const ext = path.extname(file.originalname).toLowerCase();
  // Falls back to a generic binary type rather than trusting file.mimetype —
  // reachable only if a caller bypasses upload.middleware.js's fileFilter,
  // since every extension it allows has an entry here.
  const contentType = MIME_BY_EXTENSION[ext] || 'application/octet-stream';
  const contentDisposition = DOWNLOAD_ONLY_EXTENSIONS.has(ext) ? 'attachment' : undefined;

  if (R2_ENABLED) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.r2.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: contentType,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
      })
    );
    return { url: `${config.r2.publicUrl.replace(/\/$/, '')}/${key}` };
  }

  fs.writeFileSync(path.join(UPLOAD_DIR, key), file.buffer);
  // Built from this API's own configured base URL, not the request's
  // protocol/Host header — see config.publicApiUrl's own comment for why.
  return { url: `${config.publicApiUrl}/uploads/${key}` };
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
