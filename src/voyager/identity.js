"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseProfileIdentity = parseProfileIdentity;
const api_error_js_1 = require("../VoyagerError");
const profile_root_js_1 = require("./profile-root.js");
const warningDefinitions = {
    name: {
        code: 'IDENTITY_NAME_PARTIAL',
        message: 'Some supported name fields were missing from the response.',
    },
    headline: {
        code: 'IDENTITY_HEADLINE_UNAVAILABLE',
        message: 'The profile headline could not be read from the supported response fields.',
    },
    about: {
        code: 'IDENTITY_ABOUT_UNAVAILABLE',
        message: 'The profile about text could not be read from the supported response fields.',
    },
    location: {
        code: 'IDENTITY_LOCATION_UNAVAILABLE',
        message: 'The profile location could not be read from the supported response fields.',
    },
};
function schemaChanged() {
    throw new api_error_js_1.ApiError('UPSTREAM_SCHEMA_CHANGED');
}
function readText(entity, field) {
    const value = Object.hasOwn(entity, field) ? entity[field] : undefined;
    if (value === undefined)
        return { value: null, state: 'missing' };
    if (value === null)
        return { value: null, state: 'empty' };
    if (typeof value !== 'string')
        return { value: null, state: 'invalid' };
    const trimmed = value.trim();
    return trimmed.length === 0
        ? { value: null, state: 'empty' }
        : { value: trimmed, state: 'value' };
}
function warn(warnings, field) {
    warnings.push({ ...warningDefinitions[field], section: 'identity' });
}
function optionalText(scalar, field, warnings) {
    if (scalar.state === 'missing' || scalar.state === 'invalid')
        warn(warnings, field);
    return scalar.value;
}
function readLink(entity, field) {
    const direct = Object.hasOwn(entity, field);
    const normalized = Object.hasOwn(entity, `*${field}`);
    return {
        value: direct ? entity[field] : normalized ? entity[`*${field}`] : undefined,
        ambiguous: direct && normalized,
    };
}
function readLocation(root, graph) {
    const direct = readText(root, 'locationName');
    if (direct.state === 'value' || direct.state === 'invalid')
        return direct;
    const locationLink = readLink(root, 'geoLocation');
    if (locationLink.ambiguous)
        return { value: null, state: 'invalid' };
    if (locationLink.value === undefined)
        return direct;
    if (locationLink.value === null)
        return { value: null, state: 'empty' };
    const location = graph.resolve(locationLink.value);
    if (location === null || location === root)
        return { value: null, state: 'invalid' };
    const geoLink = readLink(location, 'geo');
    if (geoLink.ambiguous)
        return { value: null, state: 'invalid' };
    if (geoLink.value === undefined)
        return { value: null, state: 'missing' };
    if (geoLink.value === null)
        return { value: null, state: 'empty' };
    const geo = graph.resolve(geoLink.value);
    if (geo === null || geo === root || geo === location)
        return { value: null, state: 'invalid' };
    // This is a fixed, two-link path, not an expansion of arbitrary graph fields.
    // Locale maps and URNs are deliberately not interpreted as location names.
    return readText(geo, 'defaultLocalizedName');
}
/** Parse only identity fields whose scalar or explicit-link form is supported. */
function parseProfileIdentity(payload, target) {
    const { graph, root } = (0, profile_root_js_1.selectLinkedInProfileRoot)(payload, target.publicIdentifier);
    const first = readText(root, 'firstName');
    const last = readText(root, 'lastName');
    if (first.state === 'invalid' || last.state === 'invalid')
        schemaChanged();
    if (first.value === null && last.value === null)
        schemaChanged();
    const warnings = [];
    if (first.state === 'missing' || last.state === 'missing')
        warn(warnings, 'name');
    const headline = optionalText(readText(root, 'headline'), 'headline', warnings);
    const about = optionalText(readText(root, 'summary'), 'about', warnings);
    const location = optionalText(readLocation(root, graph), 'location', warnings);
    return {
        graph,
        root,
        identity: {
            canonicalUrl: target.canonicalUrl,
            publicIdentifier: target.publicIdentifier,
            firstName: first.value,
            lastName: last.value,
            // Without confirmed locale metadata, preserve the supplied given/family
            // strings and join them; do not guess localized name ordering.
            fullName: [first.value, last.value].filter((value) => value !== null).join(' '),
            headline,
            location,
            about,
        },
        state: warnings.length === 0 ? 'complete' : 'partial',
        warnings,
    };
}

