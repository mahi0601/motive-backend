const WorkspaceService = require('../services/workspace.service');

exports.list = async (req, res, next) => {
  try {
    const workspaces = await WorkspaceService.listForUser(req.user.id);
    res.json(workspaces);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const ws = await WorkspaceService.create(req.body, req.user.id);
    res.status(201).json(ws);
  } catch (err) {
    next(err);
  }
};
