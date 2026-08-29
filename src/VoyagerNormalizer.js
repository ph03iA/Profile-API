const crypto = require('crypto');

const { parseProfileIdentity } = require('./voyager/identity');
const { parseProfileImages } = require('./voyager/images');
const { parseProfileSections } = require('./voyager/sections');

function normalizeVoyagerProfile(payload, target, fetchedAt) {
	const identity = parseProfileIdentity(payload, target);
	const images = parseProfileImages(identity.root, identity.graph);
	const sections = parseProfileSections(identity.root, identity.graph);
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
			warnings: identity.warnings.concat(sections.warnings, images.warnings),
			transport: 'linkedin-voyager'
		}
	});
}

module.exports = { normalizeVoyagerProfile };
