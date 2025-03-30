// src/app.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const routes = require('./routes');
const { errorHandler } = require('./middlewares/error.middleware');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev'));

// Routes
app.use('/api', routes);

// Health Check Route
app.get('/', (_req, res) => {
  res.send('✅ Backend Server is Up & Running!');
});

// Error handler middleware
app.use(errorHandler);

module.exports = app;
