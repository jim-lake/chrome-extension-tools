'use strict';

const defineManifest = (manifest) => manifest;
const defineDynamicResource = ({
  matches = ["http://*/*", "https://*/*"],
  use_dynamic_url = false
}) => ({
  matches,
  resources: [DYNAMIC_RESOURCE],
  use_dynamic_url
});
const DYNAMIC_RESOURCE = "<dynamic_resource>";

exports.defineDynamicResource = defineDynamicResource;
exports.defineManifest = defineManifest;
