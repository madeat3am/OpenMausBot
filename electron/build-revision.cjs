"use strict";

const FULL_GIT_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function packagedBuildRevision(metadata) {
  const revision = typeof metadata?.buildRevision === "string"
    ? metadata.buildRevision.trim().toLowerCase()
    : "";
  return FULL_GIT_REVISION.test(revision) ? revision : "unknown";
}

module.exports = { packagedBuildRevision };
