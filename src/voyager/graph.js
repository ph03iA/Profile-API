"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoyagerGraph = void 0;
const api_error_js_1 = require("../VoyagerError");
const MAX_INCLUDED_ENTITIES = 2_000;
const MAX_ROOT_ELEMENTS = 100;
const MAX_URN_LENGTH = 4_096;
function schemaChanged() {
    // Never attach the payload or an upstream identifier to an error.
    throw new api_error_js_1.ApiError('UPSTREAM_SCHEMA_CHANGED');
}
function isEntity(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isUrn(value) {
    return (typeof value === 'string' &&
        value.length > 'urn:li:'.length &&
        value.length <= MAX_URN_LENGTH &&
        value.startsWith('urn:li:') &&
        !/[\s\p{Cc}\p{Cf}]/u.test(value));
}
function readRoots(payload) {
    let data;
    if (Object.hasOwn(payload, 'data')) {
        if (!isEntity(payload.data))
            schemaChanged();
        data = payload.data;
    }
    const candidates = [];
    if (data !== undefined) {
        if (Object.hasOwn(data, '*elements'))
            candidates.push(data['*elements']);
        if (Object.hasOwn(data, 'elements'))
            candidates.push(data.elements);
    }
    if (Object.hasOwn(payload, 'elements'))
        candidates.push(payload.elements);
    // Do not silently choose a different root collection if the envelope changes.
    if (candidates.length !== 1)
        schemaChanged();
    const roots = candidates[0];
    if (!Array.isArray(roots) || roots.length > MAX_ROOT_ELEMENTS)
        schemaChanged();
    return roots;
}
/**
 * A bounded, single-hop view of a normalized JSON graph. Entities are borrowed
 * from the input, not recursively expanded or copied; callers must not mutate
 * them. Profile identity and application-error validation belong to the caller.
 */
class VoyagerGraph {
    entities = new Map();
    roots;
    count;
    constructor(payload) {
        if (!isEntity(payload))
            schemaChanged();
        const rawRoots = readRoots(payload);
        const included = Object.hasOwn(payload, 'included') ? payload.included : [];
        if (!Array.isArray(included) || included.length > MAX_INCLUDED_ENTITIES)
            schemaChanged();
        this.count = included.length;
        for (const value of included) {
            if (!isEntity(value))
                schemaChanged();
            this.indexEntity(value);
        }
        // Index inline roots too, so a declared identifier can never resolve to a
        // conflicting included entity. This does not inspect arbitrary nested data.
        for (const value of rawRoots) {
            if (isEntity(value))
                this.indexEntity(value);
        }
        const roots = [];
        const seen = new Set();
        for (const reference of rawRoots) {
            const entity = this.resolve(reference);
            if (entity === null || seen.has(entity))
                schemaChanged();
            roots.push(entity);
            seen.add(entity);
        }
        this.roots = Object.freeze(roots);
    }
    get includedCount() {
        return this.count;
    }
    /** Unknown optional links return null; unresolved declared roots never do. */
    resolve(reference) {
        if (isUrn(reference))
            return this.entities.get(reference) ?? null;
        if (!isEntity(reference))
            return null;
        if (!Object.hasOwn(reference, 'entityUrn'))
            return reference;
        const urn = reference.entityUrn;
        if (!isUrn(urn))
            return null;
        const indexed = this.entities.get(urn);
        return indexed === undefined || indexed === reference ? reference : null;
    }
    rootElements() {
        return this.roots;
    }
    indexEntity(entity) {
        if (!Object.hasOwn(entity, 'entityUrn'))
            return;
        const urn = entity.entityUrn;
        if (!isUrn(urn))
            schemaChanged();
        const existing = this.entities.get(urn);
        // Distinct copies are ambiguous, even if their current fields look equal.
        // Avoid unbounded recursive equality checks on upstream data.
        if (existing !== undefined && existing !== entity)
            schemaChanged();
        this.entities.set(urn, entity);
    }
}
exports.VoyagerGraph = VoyagerGraph;

