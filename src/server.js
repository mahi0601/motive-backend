// src/server.js
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const routes = require('./routes/index');

const app = express();

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'API is healthy' });
});

// Root welcome route
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Todo Backend</title></head>
      <body>
        <h1>🚀 Welcome to Todo Backend API</h1>
      </body>
    </html>
  `);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api', routes);


app.use(cors({
  origin: 'http://localhost:5173', // your frontend
  credentials: true
}));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('✅ MongoDB connected successfully');
    
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`🚀 Server is running at http://localhost:${PORT}`);
    });
})
.catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
});
