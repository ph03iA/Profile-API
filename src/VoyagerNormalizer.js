const crypto = require('crypto');

const { parseProfileIdentity } = require('./voyager/identity');
const { parseProfileImages } = require('./voyager/images');
const { parseProfileSections } = require('./voyager/sections');

function normalizeVoyagerProfile(payload, target, fetchedAt, skillsSupplement = null) {
	const identity = parseProfileIdentity(payload, target);
	const images = parseProfileImages(identity.root, identity.graph);
	const sections = parseProfileSections(identity.root, identity.graph);
	let warnings = sections.warnings;
	if (Array.isArray(skillsSupplement)) {
		sections.sections.skills = skillsSupplement;
		sections.sectionStatus.skills = 'complete';
		warnings = warnings.filter(warning =>
			warning.section !== 'skills' || warning.code !== 'SECTION_PARTIAL');
	}
	return Object.assign({}, identity.identity, sections.sections, {
		images: images.images,
		meta: {
			requestId: crypto.randomUUID(),
			fetchedAt: fetchedAt.toISOString(),
			sectionStatus: Object.assign({
				identity: identity.state
			}, sections.sectionStatus, {
				images: images.state
			}),
			warnings: identity.warnings.concat(warnings, images.warnings),
			transport: Array.isArray(skillsSupplement)
				? 'linkedin-voyager+rsc-skills' : 'linkedin-voyager'
		}
	});
}

module.exports = { normalizeVoyagerProfile };
