'use strict';

const crypto = require('crypto');
const { ApiError } = require('./VoyagerError');
const { RscFlight } = require('./RscFlight');

const SKILLS_ENDPOINT = 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination';
const SKILLS_PAGER_ID = 'com.linkedin.sdui.pagers.profile.details.skills';
const SKILLS_SCREEN_ID = 'com.linkedin.sdui.flagshipnav.profile.ProfileSkillDetails';
const SKILLS_FILTER = 'ProfileSkillCategory_ALL';
const PAGE_SIZE = 10;
const MAX_SEMANTIC_NODES = 100_000;
const MAX_TEXT_LENGTH = 512;
const FLIGHT_REFERENCE = /^\$(?:L|Q|W)?([0-9a-f]+)(?::.+)?$/i;
const PROFILE_SKILL_KEY = /^com\.linkedin\.sdui\.profile\.skill\(([^,]+),\s*([^)]+)\)$/;

function schemaChanged() {
	return new ApiError('UPSTREAM_SCHEMA_CHANGED');
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function printable(value, maximum = MAX_TEXT_LENGTH) {
	if (typeof value !== 'string')
		return null;
	const normalized = value.trim();
	return normalized && normalized.length <= maximum && Buffer.byteLength(normalized) <= maximum * 4 &&
		!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized) ? normalized : null;
}

function validateVanity(value) {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
}

function validateProfileId(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function requestedArguments(vanity, profileId, start) {
	return {
		$type: 'proto.sdui.actions.requests.RequestedArguments',
		requestedStateKeys: [],
		payload: {
			vanityName: vanity,
			profileId,
			start,
			count: PAGE_SIZE,
			filter: SKILLS_FILTER
		},
		requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' }
	};
}

function buildSkillsPageRequest(vanity, profileId, start) {
	if (!validateVanity(vanity) || !validateProfileId(profileId) ||
		!Number.isSafeInteger(start) || start < 0)
		throw schemaChanged();
	const argumentsForPage = requestedArguments(vanity, profileId, start);
	const url = new URL(SKILLS_ENDPOINT);
	url.searchParams.set('sduiid', SKILLS_PAGER_ID);
	url.searchParams.set('parentSpanId', crypto.randomBytes(8).toString('base64'));
	return {
		url,
		body: JSON.stringify({
			pagerId: SKILLS_PAGER_ID,
			clientArguments: Object.assign({}, argumentsForPage, {
				states: [],
				screenId: SKILLS_SCREEN_ID,
				knownTemplateIds: []
			}),
			paginationRequest: {
				$type: 'proto.sdui.actions.requests.PaginationRequest',
				pagerId: SKILLS_PAGER_ID,
				trigger: {
					$case: 'itemDistanceTrigger',
					itemDistanceTrigger: {
						$type: 'proto.sdui.actions.requests.ItemDistanceTrigger',
						preloadDistance: 3,
						preloadLength: 250
					}
				},
				retryCount: 2,
				requestedArguments: argumentsForPage
			}
		})
	};
}

function walk(value, visitor) {
	const pending = [value];
	let visited = 0;
	while (pending.length) {
		const current = pending.pop();
		if (++visited > MAX_SEMANTIC_NODES)
			throw schemaChanged();
		visitor(current);
		if (Array.isArray(current)) {
			for (let index = current.length - 1; index >= 0; index -= 1)
				pending.push(current[index]);
		} else if (isRecord(current)) {
			const values = Object.values(current);
			for (let index = values.length - 1; index >= 0; index -= 1)
				pending.push(values[index]);
		}
	}
}

function walkReferencedRecords(flight, seed, visitor) {
	const pending = [seed];
	const seenRecords = new Set();
	let visited = 0;
	while (pending.length) {
		const current = pending.pop();
		if (++visited > MAX_SEMANTIC_NODES)
			throw schemaChanged();
		visitor(current);
		if (typeof current === 'string') {
			const reference = FLIGHT_REFERENCE.exec(current);
			if (!reference)
				continue;
			const id = reference[1].toLowerCase();
			if (seenRecords.has(id))
				continue;
			const record = flight.records.get(id);
			if (!record || record.isImport)
				continue;
			seenRecords.add(id);
			pending.push(record.value);
			continue;
		}
		if (Array.isArray(current)) {
			for (let index = current.length - 1; index >= 0; index -= 1)
				pending.push(current[index]);
		} else if (isRecord(current)) {
			const values = Object.values(current);
			for (let index = values.length - 1; index >= 0; index -= 1)
				pending.push(values[index]);
		}
	}
}

function flattenText(value) {
	const pieces = [];
	function visit(item) {
		if (typeof item === 'string') {
			if (!item.startsWith('$'))
				pieces.push(item);
			return;
		}
		if (Array.isArray(item)) {
			if (item.length >= 4 && item[0] === '$') {
				if (item[1] === 'br')
					pieces.push('\n');
				else if (isRecord(item[3]))
					visit(item[3].children);
				return;
			}
			for (const child of item)
				visit(child);
			return;
		}
		if (isRecord(item) && Object.hasOwn(item, 'children'))
			visit(item.children);
	}
	visit(value);
	return pieces.join('').split(/\r?\n/).map(piece => piece.trim()).filter(Boolean).join('\n');
}

function parseSkillComponentKey(value, expectedProfileId) {
	if (typeof value !== 'string')
		return null;
	const match = PROFILE_SKILL_KEY.exec(value);
	if (match) {
		const profileId = printable(match[1].trim(), 256);
		const skillId = printable(match[2].trim(), 256);
		if (!profileId || !skillId || profileId !== expectedProfileId)
			throw schemaChanged();
		return { key: value, skillId };
	}
	if (value.startsWith('entity-collection-item-'))
		return { key: value, skillId: null };
	return null;
}

function inspectSkillGraph(flight, item, component, expectedVanity, expectedProfileId) {
	let binding = null;
	const titles = new Set();
	const textCandidates = [];
	const seed = item.initialContent === undefined ? item : item.initialContent;
	walkReferencedRecords(flight, seed, value => {
		if (!isRecord(value))
			return;
		if (Object.hasOwn(value, 'skillId') && Object.hasOwn(value, 'vanityName')) {
			const skillNamePlaceholder = value.skillName === undefined || value.skillName === null ||
				value.skillName === '$undefined';
			const candidate = {
				skillId: printable(value.skillId, 256),
				vanityName: printable(value.vanityName, 100),
				profileId: value.profileId === undefined ? null : printable(value.profileId, 256),
				skillName: skillNamePlaceholder ? null : printable(value.skillName, 256)
			};
			if (!candidate.skillId || candidate.vanityName !== expectedVanity ||
				candidate.profileId !== null && candidate.profileId !== expectedProfileId ||
				!skillNamePlaceholder && !candidate.skillName)
				throw schemaChanged();
			if (binding && (binding.skillId !== candidate.skillId || binding.skillName !== candidate.skillName))
				throw schemaChanged();
			binding = candidate;
		}
		if (!isRecord(value.textProps))
			return;
		const text = printable(flattenText(value.textProps.children), 256);
		if (!text)
			return;
		textCandidates.push(text);
		if (value.textProps.fontWeight === 'bold')
			titles.add(text);
	});
	if (binding && component.skillId && binding.skillId !== component.skillId)
		throw schemaChanged();
	if (titles.size > 1)
		throw schemaChanged();
	const title = titles.values().next().value || null;
	const name = binding && binding.skillName || title || textCandidates[0] || null;
	if (!name)
		return null;
	if (binding && binding.skillName && title && binding.skillName !== title)
		throw schemaChanged();
	return {
		name,
		endorsementCount: null,
		key: binding ? binding.skillId : component.skillId || component.key
	};
}

function parseSkillsPage(body, expectedVanity, expectedProfileId) {
	if (!validateVanity(expectedVanity) || !validateProfileId(expectedProfileId))
		throw schemaChanged();
	const flight = RscFlight.parse(body);
	const root = flight.records.get('0');
	if (!root || root.isImport)
		throw schemaChanged();
	const items = new Map();
	walk(root.value, value => {
		if (!isRecord(value))
			return;
		const key = value.componentkey || value.componentKey;
		const component = parseSkillComponentKey(key, expectedProfileId);
		if (!component)
			return;
		const previous = items.get(component.key);
		if (!previous || previous.item.initialContent === undefined && value.initialContent !== undefined)
			items.set(component.key, { component, item: value });
	});
	const typedItems = Array.from(items.values()).filter(({ component }) =>
		component.skillId !== null);
	const selectedItems = typedItems.length ? typedItems : Array.from(items.values());
	const skills = [];
	const seenNames = new Set();
	for (const { component, item } of selectedItems) {
		const skill = inspectSkillGraph(flight, item, component, expectedVanity, expectedProfileId);
		if (!skill)
			continue;
		const normalized = skill.name.toLocaleLowerCase('en-US');
		if (seenNames.has(normalized))
			throw schemaChanged();
		seenNames.add(normalized);
		skills.push(skill);
		if (skills.length > PAGE_SIZE)
			throw schemaChanged();
	}
	return skills;
}

function completeSkills(baseSkills, total, pages) {
	if (!Array.isArray(baseSkills) || !Number.isSafeInteger(total) || total <= baseSkills.length ||
		total <= 0 || !Array.isArray(pages))
		return null;
	const flattened = pages.flat();
	if (flattened.length !== total)
		return null;
	const base = new Map();
	for (const skill of baseSkills) {
		const name = printable(skill && skill.name, 256);
		if (!name || skill.name !== name || skill.endorsementCount !== null &&
			!(Number.isSafeInteger(skill.endorsementCount) && skill.endorsementCount >= 0))
			return null;
		base.set(name.toLocaleLowerCase('en-US'), skill.endorsementCount);
	}
	const seenKeys = new Set();
	const seenNames = new Set();
	const completed = [];
	for (const skill of flattened) {
		const name = printable(skill && skill.name, 256);
		const key = printable(skill && skill.key, 512);
		if (!name || !key || seenKeys.has(key))
			return null;
		const normalized = name.toLocaleLowerCase('en-US');
		if (seenNames.has(normalized))
			return null;
		seenKeys.add(key);
		seenNames.add(normalized);
		completed.push({ name, endorsementCount: base.has(normalized) ? base.get(normalized) : null });
	}
	for (const name of base.keys()) {
		if (!seenNames.has(name))
			return null;
	}
	return completed;
}

module.exports = {
	PAGE_SIZE,
	buildSkillsPageRequest,
	completeSkills,
	parseSkillsPage
};
