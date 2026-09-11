'use strict';

const multer = require('multer');

const env = require('../config/env');
const { errors } = require('../utils/errors');

/**
 * Multipart uploads.
 *
 * Memory storage rather than a temp directory: a profile photo is a few
 * megabytes, it goes straight back out to object storage, and a temp file is
 * one more thing to clean up on a crash. The size cap is what makes that safe —
 * without it, memory storage is an invitation to exhaust the heap.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.storage.maxBytes,
    // One file. `.single('photo')` already rejects a second *file* as an
    // unexpected field, so this is the belt to that pair of braces.
    //
    // No `parts` or `fields` cap: multer counts the file itself as a part, and
    // a `parts: 1` limit rejected every ordinary single-file upload — the
    // failure looked like "Send exactly one image" for a request that sent
    // exactly one image. Stray text fields are ignored by `.single()` anyway,
    // so capping them bought nothing.
    files: 1,
  },
});

const single = upload.single('photo');

/**
 * Accepts one image on the `photo` field.
 *
 * Wrapped rather than used directly so multer's own errors become this API's
 * error shape. Left alone, a file over the limit surfaces as an unhandled
 * `MulterError` — a 500 with a stack trace, for what is squarely the caller's
 * mistake and needs to reach the user as "that picture is too big".
 *
 * The type of the bytes is *not* checked here. Multer only sees the filename
 * and the `Content-Type` the client chose to send, and neither is evidence.
 * `storage.service` checks the magic bytes, which are.
 */
function avatarUpload(req, res, next) {
  single(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      const megabytes = Math.floor(env.storage.maxBytes / 1024 / 1024);
      switch (error.code) {
        case 'LIMIT_FILE_SIZE':
          return next(errors.badRequest(`Images must be under ${megabytes} MB.`));
        case 'LIMIT_UNEXPECTED_FILE':
          return next(errors.badRequest('Send the image as the "photo" field.'));
        case 'LIMIT_FILE_COUNT':
        case 'LIMIT_PART_COUNT':
        case 'LIMIT_FIELD_COUNT':
          return next(errors.badRequest('Send exactly one image.'));
        default:
          return next(errors.badRequest(`Upload rejected: ${error.message}`));
      }
    }

    // A malformed multipart body — a truncated request, or a client that set
    // the boundary wrong. Still the caller's problem, not a server fault.
    return next(errors.badRequest('That upload could not be read.'));
  });
}

/**
 * A separate multer instance from `upload` above: a voice-verification clip
 * can run larger than a compressed photo, and has its own, independent size
 * ceiling — sharing one instance would mean either a hole in the photo limit
 * or a ceiling too tight for a real recording.
 */
const verificationUploadInstance = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.storage.verificationMaxBytes,
    files: 1,
  },
});

const singleAudio = verificationUploadInstance.single('audio');

/**
 * Accepts one recording on the `audio` field, alongside whatever ordinary
 * text fields (`language_code`, `duration_seconds`) ride the same multipart
 * body.
 *
 * Same reasoning as [avatarUpload]: multer's own errors become this API's
 * error shape, and the bytes' actual type is left to `storage.service`'s
 * magic-byte check rather than trusted from the filename or `Content-Type`.
 */
function verificationUpload(req, res, next) {
  singleAudio(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      const megabytes = Math.floor(env.storage.verificationMaxBytes / 1024 / 1024);
      switch (error.code) {
        case 'LIMIT_FILE_SIZE':
          return next(errors.badRequest(`Recordings must be under ${megabytes} MB.`));
        case 'LIMIT_UNEXPECTED_FILE':
          return next(errors.badRequest('Send the recording as the "audio" field.'));
        case 'LIMIT_FILE_COUNT':
        case 'LIMIT_PART_COUNT':
        case 'LIMIT_FIELD_COUNT':
          return next(errors.badRequest('Send exactly one recording.'));
        default:
          return next(errors.badRequest(`Upload rejected: ${error.message}`));
      }
    }

    return next(errors.badRequest('That upload could not be read.'));
  });
}

module.exports = { avatarUpload, verificationUpload };
