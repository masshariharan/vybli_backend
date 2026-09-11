'use strict';

const adminAuth = require('../services/admin/auth.service');
const { errors } = require('../utils/errors');

/**
 * Guards every admin route.
 *
 * Applied to the whole `/admin` router rather than route by route, because the
 * failure mode of the alternative is a single unguarded endpoint that returns
 * somebody's private messages — and that endpoint would be indistinguishable
 * from the guarded ones until someone found it.
 *
 * The only exception is `POST /admin/auth/login`, which is mounted before
 * this runs for the obvious reason.
 */
function requireAdmin(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return next(errors.adminUnauthorized());
  }

  try {
    req.admin = adminAuth.verify(token);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAdmin };
