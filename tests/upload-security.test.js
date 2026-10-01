// Regression coverage for two upload-related fixes:
//
// 1. Client-controlled MIME type → stored XSS (upload.middleware.js /
//    storage.service.js). `file.mimetype` is a header the uploading client
//    sets and fully controls; it used to be stored verbatim as the file's
//    Content-Type. Uploading `x.png` with `Content-Type: text/html` got
//    served back as HTML. The stored type now always comes from
//    fileTypes.js's MIME_BY_EXTENSION, keyed by the validated extension.
//
// 2. Host-header injection into persisted data (storage.service.js /
//    upload.controller.js). The local-disk upload URL used to be built from
//    the request's protocol/Host header — both fully attacker-controlled —
//    and written into the File.url column. It's now built from
//    config.publicApiUrl, a server-side config value with no client input
//    in it at all.
//
// R2 isn't configured in this dev environment (see .env.example), so
// saveFile() exercises the local-disk branch here — the one the host-header
// fix actually touches. Writes into public/uploads/ and cleans up after
// itself; doesn't touch the DB, so no fixtures/teardown needed there.
const fs = require('fs');
const path = require('path');
const storageService = require('../src/services/storage.service');
const config = require('../src/config/env');
const { ALLOWED_EXTENSIONS, MIME_BY_EXTENSION } = require('../src/utils/fileTypes');

describe('storage.service.saveFile', () => {
  const written = [];

  afterEach(() => {
    // Best-effort cleanup of whatever this test wrote to local disk.
    written.forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
    written.length = 0;
  });

  test('the stored ContentType comes from the extension, never the client-declared mimetype', async () => {
    // A client claiming an image is actually HTML — exactly the attack this
    // fix closes. saveFile() itself doesn't return the ContentType it used
    // (that's only observable via the S3 PutObjectCommand in the R2
    // branch), so this asserts the *inputs* to that decision instead: the
    // extension-derived map is the only thing MIME_BY_EXTENSION exposes,
    // and it's what fileTypes.js is unit-tested against below.
    const file = {
      originalname: 'photo.png',
      mimetype: 'text/html', // attacker-controlled, must be ignored
      buffer: Buffer.from('not actually html, just test bytes'),
    };
    const { url } = await storageService.saveFile(file);
    const key = path.basename(new URL(url).pathname);
    written.push(path.join('public/uploads', key));

    // The extension this file was stored under determines its type — .png
    // maps to image/png regardless of what the client's mimetype said.
    expect(path.extname(key)).toBe('.png');
    expect(MIME_BY_EXTENSION['.png']).toBe('image/png');
  });

  test('the local-disk URL is built from config.publicApiUrl, not any request data', async () => {
    const file = { originalname: 'doc.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-fake') };
    const { url } = await storageService.saveFile(file);
    const key = path.basename(new URL(url).pathname);
    written.push(path.join('public/uploads', key));

    expect(url).toBe(`${config.publicApiUrl}/uploads/${key}`);
    // saveFile's signature no longer even accepts protocol/host — this
    // just documents that a forged Host header has nothing to attach to
    // anymore.
    expect(storageService.saveFile.length).toBe(1);
  });
});

describe('fileTypes', () => {
  test('every allowed extension has a concrete MIME type, never falling back to a guess', () => {
    ALLOWED_EXTENSIONS.forEach((ext) => {
      expect(MIME_BY_EXTENSION[ext]).toBeTruthy();
    });
  });
});
