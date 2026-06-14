const mongoose = require('mongoose');
const config = require('./env');

// Connection pooling + sane timeouts so a slow/down DB fails fast instead of
// hanging requests. maxPoolSize bounds concurrent ops per instance — tune per load.
const connectDB = async () => {
  mongoose.set('strictQuery', true);

  await mongoose.connect(config.mongoUri, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  console.log('✅ MongoDB connected');

  mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));

  return mongoose.connection;
};

module.exports = connectDB;
