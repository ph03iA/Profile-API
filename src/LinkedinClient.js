const path = require('path');

const SessionJar = require('./SessionJar');
const VoyagerHttpClient = require('./VoyagerHttpClient');
const { normalizeVoyagerProfile } = require('./VoyagerNormalizer');

function invalidUrl() {
	const error = new Error('The URL must be a canonical LinkedIn people profile URL.');
	error.code = 'INVALID_PROFILE_URL';
	return error;
}

function canonicalizeProfileUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch (error) {
		throw invalidUrl();
	}
	if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) ||
		url.port || url.username || url.password || url.search || url.hash)
		throw invalidUrl();
	const match = /^\/in\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/?$/.exec(url.pathname);
	if (!match)
		throw invalidUrl();
	return {
		publicIdentifier: match[1],
		canonicalUrl: `https://www.linkedin.com/in/${match[1]}/`
	};
}

function normalizeOptions(options) {
	if (typeof options === 'string') {
		return {
			liAt: options,
			jsessionId: process.env.LINKEDIN_JSESSIONID
		};
	}
	return options || {};
}

module.exports = class LinkedinClient {
	constructor(options) {
		const normalized = normalizeOptions(options);
		if (normalized.http) {
			this.jar = normalized.jar || null;
			this.http = normalized.http;
			return;
		}
		this.jar = normalized.jar || new SessionJar({
			liAt: normalized.liAt || process.env.LINKEDIN_LI_AT,
			jsessionId: normalized.jsessionId || process.env.LINKEDIN_JSESSIONID,
			stateFile: normalized.stateFile === undefined
				? path.resolve('.sessions/linkedin.json') : normalized.stateFile
		});
		this.http = new VoyagerHttpClient({
			jar: this.jar,
			fetch: normalized.fetch,
			timeoutMs: normalized.timeoutMs,
			cookieHeader: normalized.cookieHeader || process.env.LINKEDIN_COOKIE_HEADER,
			userAgent: normalized.userAgent || process.env.LINKEDIN_USER_AGENT
		});
	}

	async fetch(value) {
		const target = canonicalizeProfileUrl(value);
		try {
			const response = await this.http.readProfile(target.publicIdentifier);
			return normalizeVoyagerProfile(
				response.payload,
				target,
				response.fetchedAt,
				response.skillsSupplement
			);
		} catch (error) {
			if (error && error.code === 'PROFILE_NOT_FOUND')
				return null;
			throw error;
		}
	}
};

module.exports.canonicalizeProfileUrl = canonicalizeProfileUrl;
