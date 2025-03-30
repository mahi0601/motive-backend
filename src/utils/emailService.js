// src/utils/emailService.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD
  }
});

exports.sendEmail = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from: `"ToDo App" <${process.env.EMAIL_USERNAME}>`,
      to,
      subject,
      html
    });
  } catch (err) {
    console.error('📧 Email Send Error:', err.message);
  }
};
