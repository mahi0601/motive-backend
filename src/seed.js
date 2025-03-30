const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const User = require('.../../../src/models/user.model');
const Task = require('../src/models/task.model');


mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log('✅ Connected to MongoDB - Seeding...');

  // Clear old data
  await User.deleteMany({});
  await Task.deleteMany({});

  // Insert dummy user
  const user = await User.create({
    name: 'John Doe',
    email: 'john@example.com',
    password: 'hashedpassword123'
  });

  // Insert dummy task
  await Task.create({
    title: 'Test Task',
    description: 'This is a seeded task',
    status: 'pending',
    priority: 'medium',
    userId: user._id
  });

  console.log('✅ Seeding completed!');
  process.exit(0);
})
.catch((err) => {
  console.error('❌ Seeding error:', err);
  process.exit(1);
});
