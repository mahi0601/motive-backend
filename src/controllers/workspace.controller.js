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

exports.inviteMember = async (req, res, next) => {
  try {
    const member = await WorkspaceService.inviteMember(req.params.id, req.user.id, req.body.email);
    res.status(201).json({ success: true, member });
  } catch (err) {
    next(err);
  }
};
