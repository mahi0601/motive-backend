// src/index.js — entrypoint.
// Sentry must be required FIRST — see instrument.js for why.
require('./instrument');
// Loading config next validates env (and loads .env) before anything else boots.
require('./config/env');
require('./server');
