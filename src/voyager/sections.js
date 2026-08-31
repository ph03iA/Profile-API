"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectProfileSkills = inspectProfileSkills;
exports.parseProfileSections = parseProfileSections;
const sectionNames = ['experience', 'education', 'skills', 'certifications', 'languages'];
const maximumSectionEntries = 200;
const maximumExperienceGroups = 100;
function own(entity, field) {
    return Object.hasOwn(entity, field) ? entity[field] : undefined;
}
function hasExpectedType(entity, type) {
    // Inline objects may omit metadata, but a declared different entity type
    // must not be interpreted as a section entry just because fields overlap.
    return !Object.hasOwn(entity, '$type') ||
        entity.$type === 'com.linkedin.voyager.dash.identity.profile.' + type;
}
function link(entity, field) {
    const direct = Object.hasOwn(entity, field);
    const normalized = Object.hasOwn(entity, '*' + field);
    return {
        value: direct ? entity[field] : normalized ? entity['*' + field] : undefined,
        ambiguous: direct && normalized,
    };
}
function nonnegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function readCollection(parent, field, graph, ancestors) {
    const reference = link(parent, field);
    if (reference.ambiguous)
        return null;
    const entity = graph.resolve(reference.value);
    if (entity === null || ancestors.includes(entity))
        return null;
    const elements = link(entity, 'elements');
    if (elements.ambiguous || !Array.isArray(elements.value))
        return null;
    const pagingLink = link(entity, 'paging');
    const paging = pagingLink.ambiguous ? null : graph.resolve(pagingLink.value);
    const start = paging === null ? undefined : own(paging, 'start');
    const count = paging === null ? undefined : own(paging, 'count');
    const total = paging === null ? undefined : own(paging, 'total');
    const validatedPaging = paging !== null && paging !== entity && !ancestors.includes(paging) &&
        nonnegativeInteger(start) && nonnegativeInteger(count) && nonnegativeInteger(total)
        ? { start, count, total }
        : null;
    // A requested page size may exceed the returned count. Only an explicit
    // first page covering the reported total establishes complete coverage.
    const complete = validatedPaging !== null && validatedPaging.start === 0 &&
        validatedPaging.count >= elements.value.length &&
        validatedPaging.total === elements.value.length;
    return {
        entity,
        elements: elements.value,
        complete,
        paging: validatedPaging,
    };
}
function optionalText(entity, field, state) {
    const value = own(entity, field);
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string') {
        state.complete = false;
        return null;
    }
    return value.trim() || null;
}
function relatedName(entity, field, graph, state) {
    const reference = link(entity, field);
    if (reference.ambiguous) {
        state.complete = false;
        return null;
    }
    if (reference.value === undefined || reference.value === null)
        return null;
    const related = graph.resolve(reference.value);
    if (related === null || related === entity) {
        state.complete = false;
        return null;
    }
    const name = optionalText(related, 'name', state);
    if (name === null)
        state.complete = false;
    return name;
}
function readDate(reference, graph, state, ancestors) {
    if (reference.ambiguous) {
        state.complete = false;
        return null;
    }
    if (reference.value === undefined || reference.value === null)
        return null;
    const date = graph.resolve(reference.value);
    if (date === null || ancestors.includes(date)) {
        state.complete = false;
        return null;
    }
    const year = own(date, 'year');
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 1900 || year > 2100) {
        state.complete = false;
        return null;
    }
    const month = own(date, 'month');
    if (month === undefined || month === null)
        return { year, month: null };
    if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) {
        state.complete = false;
        return { year, month: null };
    }
    return { year, month };
}
function dateRange(entity, graph, state) {
    const reference = link(entity, 'dateRange');
    const empty = { startDate: null, endDate: null };
    if (reference.ambiguous) {
        state.complete = false;
        return empty;
    }
    if (reference.value === undefined || reference.value === null)
        return empty;
    const range = graph.resolve(reference.value);
    if (range === null || range === entity) {
        state.complete = false;
        return empty;
    }
    return {
        startDate: readDate(link(range, 'start'), graph, state, [entity, range]),
        endDate: readDate(link(range, 'end'), graph, state, [entity, range]),
    };
}
function currentPosition(entity, startDate, endDate, graph, state) {
    const value = own(entity, 'isCurrent');
    if (value === undefined || value === null) {
        if (endDate !== null)
            return false;
        if (startDate === null)
            return null;
        const rangeLink = link(entity, 'dateRange');
        const range = rangeLink.ambiguous ? null : graph.resolve(rangeLink.value);
        if (range === null)
            return null;
        const end = link(range, 'end');
        // The supported ongoing-position shape has a usable start and no end.
        // A malformed/unresolved end must not be mistaken for this shape.
        return !end.ambiguous && (end.value === undefined || end.value === null) ? true : null;
    }
    if (typeof value !== 'boolean' || (value && endDate !== null)) {
        state.complete = false;
        return null;
    }
    return value;
}
function parsePosition(entity, group, graph) {
    const state = { complete: true };
    const title = optionalText(entity, 'title', state);
    const company = optionalText(entity, 'companyName', state) ??
        relatedName(entity, 'company', graph, state) ??
        optionalText(group, 'companyName', state) ??
        relatedName(group, 'company', graph, state);
    if (title === null && company === null)
        return { value: null, complete: false };
    const dates = dateRange(entity, graph, state);
    const value = {
        title, company,
        employmentType: optionalText(entity, 'employmentType', state),
        location: optionalText(entity, 'locationName', state),
        ...dates,
        isCurrent: currentPosition(entity, dates.startDate, dates.endDate, graph, state),
        description: optionalText(entity, 'description', state),
    };
    return { value, complete: state.complete };
}
function parseEducation(entity, graph) {
    const state = { complete: true };
    const school = optionalText(entity, 'schoolName', state) ??
        relatedName(entity, 'school', graph, state) ?? relatedName(entity, 'company', graph, state);
    const degree = optionalText(entity, 'degreeName', state);
    const fieldOfStudy = optionalText(entity, 'fieldOfStudy', state);
    if (school === null && degree === null && fieldOfStudy === null)
        return { value: null, complete: false };
    const value = {
        school, degree, fieldOfStudy,
        ...dateRange(entity, graph, state),
        description: optionalText(entity, 'description', state),
    };
    return { value, complete: state.complete };
}
function parseSkill(entity) {
    const state = { complete: true };
    const name = optionalText(entity, 'name', state);
    if (name === null)
        return { value: null, complete: false };
    const count = own(entity, 'endorsementCount');
    const endorsementCount = nonnegativeInteger(count) ? count : null;
    if (count !== undefined && count !== null && endorsementCount === null)
        state.complete = false;
    return { value: { name, endorsementCount }, complete: state.complete };
}
function credentialUrl(entity, state) {
    const value = optionalText(entity, 'url', state);
    if (value === null)
        return null;
    if (value.length <= 4096 && !/[\\\p{Cc}\p{Cf}]/u.test(value)) {
        try {
            const url = new URL(value);
            if ((url.protocol === 'https:' || url.protocol === 'http:') &&
                url.username === '' && url.password === '' && url.href.length <= 4096)
                return url.href;
        }
        catch { /* Unsupported URLs are represented as null, never fetched. */ }
    }
    state.complete = false;
    return null;
}
function parseCertification(entity, graph) {
    const state = { complete: true };
    const name = optionalText(entity, 'name', state);
    const issuer = optionalText(entity, 'authority', state) ?? relatedName(entity, 'company', graph, state);
    if (name === null && issuer === null)
        return { value: null, complete: false };
    const dates = dateRange(entity, graph, state);
    const value = {
        name, issuer,
        issueDate: dates.startDate,
        expirationDate: dates.endDate,
        credentialId: optionalText(entity, 'licenseNumber', state),
        credentialUrl: credentialUrl(entity, state),
    };
    return { value, complete: state.complete };
}
function parseLanguage(entity) {
    const state = { complete: true };
    const name = optionalText(entity, 'name', state);
    if (name === null)
        return { value: null, complete: false };
    const proficiency = optionalText(entity, 'proficiency', state);
    return { value: { name, proficiency }, complete: state.complete };
}
function entityKey(entity) {
    const urn = own(entity, 'entityUrn');
    return typeof urn === 'string' ? urn : entity;
}
/**
 * Inspect only the explicitly linked embedded skills collection.
 *
 * Pagination eligibility is intentionally stricter than partial-section
 * parsing: every returned item and all paging metadata must be trustworthy
 * before the transport is allowed to request more profile data.
 */
function inspectProfileSkills(root, graph) {
    const collection = readCollection(root, 'profileSkills', graph, [root]);
    if (collection === null) {
        return { values: [], state: 'unavailable', paging: null, paginationEligible: false };
    }
    const values = [];
    const seen = new Set();
    let entriesComplete = collection.elements.length <= maximumSectionEntries;
    for (let index = 0; index < Math.min(collection.elements.length, maximumSectionEntries); index += 1) {
        const entity = graph.resolve(collection.elements[index]);
        if (entity === null || entity === root || entity === collection.entity ||
            !hasExpectedType(entity, 'Skill') || seen.has(entityKey(entity))) {
            entriesComplete = false;
            continue;
        }
        seen.add(entityKey(entity));
        const parsed = parseSkill(entity);
        entriesComplete = entriesComplete && parsed.complete;
        if (parsed.value !== null)
            values.push(parsed.value);
    }
    const returnedCount = collection.elements.length;
    const paging = collection.paging;
    return {
        values,
        state: collection.complete && entriesComplete ? 'complete' : 'partial',
        paging,
        paginationEligible: entriesComplete && returnedCount > 0 && values.length === returnedCount &&
            paging !== null && paging.start === 0 && paging.total > returnedCount,
    };
}
function readFlatSection(root, field, type, graph, parse) {
    const collection = readCollection(root, field, graph, [root]);
    if (collection === null)
        return { values: [], state: 'unavailable' };
    const values = [];
    const seen = new Set();
    let complete = collection.complete && collection.elements.length <= maximumSectionEntries;
    for (let index = 0; index < Math.min(collection.elements.length, maximumSectionEntries); index += 1) {
        const entity = graph.resolve(collection.elements[index]);
        if (entity === null || entity === root || entity === collection.entity ||
            !hasExpectedType(entity, type) || seen.has(entityKey(entity))) {
            complete = false;
            continue;
        }
        seen.add(entityKey(entity));
        const parsed = parse(entity, graph);
        complete = complete && parsed.complete;
        if (parsed.value !== null)
            values.push(parsed.value);
    }
    return { values, state: complete ? 'complete' : 'partial' };
}
function readExperience(root, graph) {
    const groups = readCollection(root, 'profilePositionGroups', graph, [root]);
    if (groups === null)
        return { values: [], state: 'unavailable' };
    const values = [];
    const seenGroups = new Set();
    const seenPositions = new Set();
    let complete = groups.complete && groups.elements.length <= maximumExperienceGroups;
    let remaining = maximumSectionEntries;
    for (let index = 0; index < Math.min(groups.elements.length, maximumExperienceGroups); index += 1) {
        const group = graph.resolve(groups.elements[index]);
        if (group === null || group === root || group === groups.entity ||
            !hasExpectedType(group, 'PositionGroup') || seenGroups.has(entityKey(group))) {
            complete = false;
            continue;
        }
        seenGroups.add(entityKey(group));
        const ancestors = [root, groups.entity, group];
        const positions = readCollection(group, 'profilePositionInPositionGroup', graph, ancestors);
        if (positions === null) {
            complete = false;
            continue;
        }
        complete = complete && positions.complete && positions.elements.length <= remaining;
        const length = Math.min(positions.elements.length, remaining);
        remaining -= length;
        for (let positionIndex = 0; positionIndex < length; positionIndex += 1) {
            const entity = graph.resolve(positions.elements[positionIndex]);
            if (entity === null || entity === positions.entity || ancestors.includes(entity) ||
                !hasExpectedType(entity, 'Position') || seenPositions.has(entityKey(entity))) {
                complete = false;
                continue;
            }
            seenPositions.add(entityKey(entity));
            const parsed = parsePosition(entity, group, graph);
            complete = complete && parsed.complete;
            if (parsed.value !== null)
                values.push(parsed.value);
        }
    }
    return { values, state: complete ? 'complete' : 'partial' };
}
/** Normalize only section collections explicitly linked from the selected profile. */
function parseProfileSections(root, graph) {
    const parsed = {
        experience: readExperience(root, graph),
        education: readFlatSection(root, 'profileEducations', 'Education', graph, parseEducation),
        skills: inspectProfileSkills(root, graph),
        certifications: readFlatSection(root, 'profileCertifications', 'Certification', graph, parseCertification),
        languages: readFlatSection(root, 'profileLanguages', 'Language', graph, parseLanguage),
    };
    const warnings = [];
    for (const section of sectionNames) {
        const state = parsed[section].state;
        if (state === 'complete')
            continue;
        warnings.push({
            section,
            code: state === 'unavailable' ? 'SECTION_UNAVAILABLE' : 'SECTION_PARTIAL',
            message: state === 'unavailable'
                ? 'This section was not available through a supported profile-linked collection.'
                : 'Some records, fields, or pages in this section could not be read completely.',
        });
    }
    return {
        sections: {
            experience: parsed.experience.values,
            education: parsed.education.values,
            skills: parsed.skills.values,
            certifications: parsed.certifications.values,
            languages: parsed.languages.values,
        },
        sectionStatus: {
            experience: parsed.experience.state,
            education: parsed.education.state,
            skills: parsed.skills.state,
            certifications: parsed.certifications.state,
            languages: parsed.languages.state,
        },
        warnings,
    };
}

