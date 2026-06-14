const PageService = require('../services/page.service');

exports.list = async (req, res, next) => {
  try {
    const pages = await PageService.list(req.user.id, { workspaceId: req.query.workspaceId });
    res.json(pages);
  } catch (err) {
    next(err);
  }
};

exports.search = async (req, res, next) => {
  try {
    const results = await PageService.search(req.query.q, req.user.id);
    res.json(results);
  } catch (err) {
    next(err);
  }
};

exports.getOne = async (req, res, next) => {
  try {
    const page = await PageService.getById(req.params.id, req.user.id);
    res.json(page);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const page = await PageService.create(req.body, req.user.id);
    res.status(201).json(page);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const page = await PageService.update(req.params.id, req.body, req.user.id);
    res.json(page);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await PageService.remove(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
};
