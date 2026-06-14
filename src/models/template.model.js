const mongoose = require('mongoose');

// A user-saved custom template: a named snapshot of a page's blocks.
const templateBlockSchema = new mongoose.Schema(
  {
    type: { type: String, default: 'paragraph' },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    icon: { type: String, default: '⭐' },
    description: { type: String, default: '', maxlength: 280 },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    blocks: { type: [templateBlockSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', templateSchema);
