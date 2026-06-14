const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'Untitled' },
    icon: { type: String, default: '📄' },
    cover: { type: String, default: '' },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Page', default: null, index: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    archived: { type: Boolean, default: false },
    favorite: { type: Boolean, default: false },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Full-text search across titles
pageSchema.index({ title: 'text' });

module.exports = mongoose.model('Page', pageSchema);
