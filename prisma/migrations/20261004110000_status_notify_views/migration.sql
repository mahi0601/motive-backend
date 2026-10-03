-- Additive: whether the owner is told when their client status page is opened. On by
-- default (the feature is opt-out), including for existing workspaces.
ALTER TABLE "Workspace" ADD COLUMN "statusNotifyViews" BOOLEAN NOT NULL DEFAULT true;
