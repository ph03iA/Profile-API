"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseProfileImages = parseProfileImages;
const maximumUrlLength = 4_096;
const maximumVariants = 64;
const unsafeCharacters = /[\\\p{Cc}\p{Cf}]/u;
const malformedEscape = /%(?![\da-f]{2})/iu;
function decodedSafe(value) {
    if (unsafeCharacters.test(value) || malformedEscape.test(value))
        return null;
    try {
        const decoded = decodeURIComponent(value);
        return unsafeCharacters.test(decoded) ? null : decoded;
    }
    catch {
        return null;
    }
}
function validPath(value, relative) {
    if (relative && (value === '' || value.startsWith('/') || /^[a-z][\da-z+.-]*:/iu.test(value))) {
        return false;
    }
    // Encoded separators, query/fragment delimiters and nested escapes have
    // ambiguous path semantics across servers. They are not supported here.
    if (/%(?:2f|5c|3f|23|25)/iu.test(value))
        return false;
    const decoded = decodedSafe(value);
    return decoded !== null && !decoded.split('/').some((part) => part === '.' || part === '..');
}
function parseRootUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximumUrlLength ||
        value.trim() !== value || unsafeCharacters.test(value))
        return null;
    // A query on the root prefix has no confirmed joining semantics. Artifact
    // queries are supported below, but root queries and all fragments are not.
    const components = /^https?:\/\/([^/?#]+)([^?#]*)$/iu.exec(value);
    if (components === null || components[1]?.includes('@') || !validPath(components[2] ?? '', false)) {
        return null;
    }
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.username === '' && url.password === '' && url.href.length <= maximumUrlLength
            ? url : null;
    }
    catch {
        return null;
    }
}
function artifactUrl(root, segment) {
    if (typeof segment !== 'string' || segment.length > maximumUrlLength ||
        segment.trim() !== segment || segment.includes('#') || unsafeCharacters.test(segment))
        return null;
    const queryStart = segment.indexOf('?');
    const path = queryStart === -1 ? segment : segment.slice(0, queryStart);
    const query = queryStart === -1 ? '' : segment.slice(queryStart + 1);
    if (!validPath(path, true) || decodedSafe(query) === null)
        return null;
    try {
        // A vector root can be a filename prefix, not just a directory. Concatenate
        // first, then verify containment; URL(segment, root) would discard a prefix.
        const url = new URL(root.href + segment);
        if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) ||
            url.username !== '' || url.password !== '' || url.hash !== '' || url.href.length > maximumUrlLength) {
            return null;
        }
        // Do not round-trip through URLSearchParams: signed query order and escapes
        // must not be rewritten. This only returns a URL; it never downloads it.
        return url.href;
    }
    catch {
        return null;
    }
}
function dimension(value) {
    if (value === null || value === undefined)
        return { value: null, valid: true };
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? { value, valid: true } : { value: null, valid: false };
}
function readReference(entity, field) {
    const direct = Object.hasOwn(entity, field);
    const normalized = Object.hasOwn(entity, `*${field}`);
    return {
        value: direct ? entity[field] : normalized ? entity[`*${field}`] : undefined,
        ambiguous: direct && normalized,
    };
}
function resolveReference(reference, graph, ancestors) {
    const entity = graph.resolve(reference);
    if (entity === null || ancestors.has(entity))
        return null;
    ancestors.add(entity);
    return entity;
}
function imageVector(root, kind, graph, ancestors) {
    const pictureLink = readReference(root, kind);
    if (pictureLink.ambiguous)
        return null;
    const picture = resolveReference(pictureLink.value, graph, ancestors);
    if (picture === null)
        return null;
    const displayFields = kind === 'profilePicture'
        ? ['displayImageWithFrameReferenceUnion', 'displayImageReference']
        : ['displayImageReference'];
    let displayReference;
    for (const field of displayFields) {
        const link = readReference(picture, field);
        if (link.ambiguous)
            return null;
        if (link.value === null || link.value === undefined)
            continue;
        // Prefer the framed profile display; use the legacy display only when the
        // union is absent/null, not when a populated chosen union is malformed.
        displayReference = link.value;
        break;
    }
    const display = resolveReference(displayReference, graph, ancestors);
    if (display === null)
        return null;
    const vectorLink = readReference(display, 'vectorImage');
    return vectorLink.ambiguous ? null : resolveReference(vectorLink.value, graph, ancestors);
}
function parseImageKind(root, kind, graph, remaining) {
    const ancestors = new Set([root]);
    const vector = imageVector(root, kind, graph, ancestors);
    const rootUrl = parseRootUrl(vector?.rootUrl);
    const artifactLink = vector === null ? null : readReference(vector, 'artifacts');
    const artifacts = artifactLink?.value;
    if (rootUrl === null || artifactLink?.ambiguous || !Array.isArray(artifacts) || artifacts.length === 0) {
        return { variants: [], complete: false };
    }
    const variants = [];
    const byUrl = new Map();
    let complete = artifacts.length <= maximumVariants;
    // Inspect at most 64 records per kind, even when duplicates or invalid
    // records would otherwise prevent the output limit from being reached.
    for (let index = 0; index < Math.min(artifacts.length, maximumVariants); index += 1) {
        const artifact = graph.resolve(artifacts[index]);
        const url = artifactUrl(rootUrl, artifact?.fileIdentifyingUrlPathSegment);
        if (artifact === null || ancestors.has(artifact) || url === null) {
            complete = false;
            continue;
        }
        const width = dimension(artifact.width);
        const height = dimension(artifact.height);
        complete = complete && width.valid && height.valid;
        const existing = byUrl.get(url);
        if (existing !== undefined) {
            if (existing.width !== width.value || existing.height !== height.value)
                complete = false;
            continue;
        }
        if (variants.length >= remaining) {
            complete = false;
            continue;
        }
        const variant = { url, width: width.value, height: height.value };
        variants.push(variant);
        byUrl.set(url, variant);
    }
    return { variants, complete: complete && variants.length > 0 };
}
function parseProfileImages(root, graph) {
    const profile = parseImageKind(root, 'profilePicture', graph, maximumVariants);
    const background = parseImageKind(root, 'backgroundPicture', graph, maximumVariants - profile.variants.length);
    const images = { profile: profile.variants, background: background.variants };
    if (profile.complete && background.complete)
        return { images, state: 'complete', warnings: [] };
    const state = images.profile.length + images.background.length > 0 ? 'partial' : 'unavailable';
    return {
        images,
        state,
        warnings: [{
                code: state === 'partial' ? 'IMAGES_PARTIAL' : 'IMAGES_UNAVAILABLE',
                section: 'images',
                message: state === 'partial'
                    ? 'Some image variants or metadata could not be read from the supported response format.'
                    : 'Images could not be read from the supported response format; this does not establish that no images exist.',
            }],
    };
}

