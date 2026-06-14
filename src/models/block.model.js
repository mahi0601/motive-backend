const mongoose = require('mongoose');

const BLOCK_TYPES = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulleted',
  'numbered',
  'todo',
  'toggle',
  'quote',
  'code',
  'divider',
  'image',
  'callout',
];

const blockSchema = new mongoose.Schema(
  {
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Page', required: true, index: true },
    type: { type: String, enum: BLOCK_TYPES, default: 'paragraph' },
    // Flexible payload: { text, checked, language, url, caption, collapsed, color, ... }
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Text index to support full-text search across block content
blockSchema.index({ 'content.text': 'text' });

module.exports = mongoose.model('Block', blockSchema);
module.exports.BLOCK_TYPES = BLOCK_TYPES;
