'use strict';

const express = require('express');
const helmet = require('helmet');
const avatarCatalog = require('./config/avatarCatalog');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const env = require('./config/env');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { globalLimiter } = require('./middleware/rateLimit');

/**
 * The Express application.
 *
 * Exported without being started so tests can mount it directly, and so
 * `server.js` owns the one decision this file should not make: when to listen.
 */
function createApp() {
  const app = express();

  // Behind a load balancer, so `req.ip` is the client rather than the proxy —
  // rate limiting keyed on the proxy's address would throttle everyone at once.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin.includes('*') ? true : env.corsOrigin,
      credentials: true,
    })
  );
  app.use(compression());

  // 1MB is generous for JSON — attachments are uploaded elsewhere and
  // referenced by URL, so nothing here should approach it.
  app.use(
    express.json({
      limit: '1mb',
      type: (req) =>
        Boolean(req.headers['content-type']) && /json/i.test(req.headers['content-type']),
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  if (!env.isTest) {
    app.use(morgan('combined'));
  }

  app.use(globalLimiter);

  app.get('/', (_req, res) =>
    res.json({
      success: true,
      message: 'Vybli API',
      data: { version: '1.0.0', docs: '/api/v1/health' },
    })
  );

  // The predefined avatar catalog — bundled with the code, not user content,
  // so unlike an upload it survives every redeploy and needs no object
  // storage at all. Served by this same server in every environment.
  //
  // Cross-origin is opened deliberately — the admin panel is served from a
  // different origin and has to render these images too.
  app.use(
    '/avatars',
    (_req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(avatarCatalog.ROOT, {
      maxAge: '7d',
      index: false,
      dotfiles: 'deny',
    })
  );

  app.use('/api/v1', routes);

  // Order matters: unmatched routes become a 404 error, and the handler after
  // it turns every error into the standard envelope.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
