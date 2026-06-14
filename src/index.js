// src/index.js — entrypoint.
// Loading config first validates env (and loads .env) before anything else boots.
require('./config/env');
require('./server');
