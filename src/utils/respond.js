'use strict';

/**
 * The two response shapes, in one place.
 *
 * Every endpoint answers with exactly one of these, so the Flutter client has
 * a single envelope to unwrap rather than a per-endpoint guess:
 *
 *   { "success": true,  "message": "...", "data": { ... } }
 *   { "success": false, "message": "...", "error": "CODE", "details": ... }
 */

function ok(res, data = {}, message = 'Request successful', status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function created(res, data = {}, message = 'Created') {
  return ok(res, data, message, 201);
}

function noContentOk(res, message = 'Done') {
  return ok(res, {}, message, 200);
}

/**
 * A page of results.
 *
 * `items` rather than a resource-specific key so a client can write one
 * pagination helper: every list endpoint in the API returns this shape.
 */
function paginated(res, items, { page, limit, total }, message = 'Request successful') {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return res.status(200).json({
    success: true,
    message,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_previous: page > 1,
      },
    },
  });
}

module.exports = { ok, created, noContentOk, paginated };
