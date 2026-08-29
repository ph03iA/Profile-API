"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectLinkedInProfileRoot = selectLinkedInProfileRoot;
const api_error_js_1 = require("../VoyagerError");
const graph_js_1 = require("./graph.js");
const profileUrnPrefix = 'urn:li:fsd_profile:';
const profileType = 'com.linkedin.voyager.dash.identity.profile.Profile';
function schemaChanged() {
    throw new api_error_js_1.ApiError('UPSTREAM_SCHEMA_CHANGED');
}
/** Select the one declared profile root and bind it to the requested vanity name. */
function selectLinkedInProfileRoot(payload, publicIdentifier) {
    const graph = new graph_js_1.VoyagerGraph(payload);
    const roots = graph.rootElements();
    if (roots.length === 0)
        throw new api_error_js_1.ApiError('PROFILE_NOT_FOUND');
    const root = roots.length === 1 ? roots[0] : undefined;
    if (root === undefined)
        schemaChanged();
    const urn = Object.hasOwn(root, 'entityUrn') ? root.entityUrn : undefined;
    if (typeof urn !== 'string' || !urn.startsWith(profileUrnPrefix) ||
        urn.length <= profileUrnPrefix.length ||
        (Object.hasOwn(root, '$type') && root.$type !== profileType) ||
        !Object.hasOwn(root, 'publicIdentifier') ||
        typeof root.publicIdentifier !== 'string' || root.publicIdentifier.length === 0 ||
        root.publicIdentifier !== publicIdentifier)
        schemaChanged();
    return { graph, profileId: urn.slice(profileUrnPrefix.length), root };
}

