const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_COOKIES = 64;
const MAX_COOKIE_VALUE = 4096;
const STATE_VERSION = 1;
const linkedinHosts = new Set(['linkedin.com', 'www.linkedin.com']);

function own(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function trustedUrl(value) {
	let url;
	try {
		url = value instanceof URL ? new URL(value.href) : new URL(value);
	} catch (error) {
		return null;
	}
	return url.protocol === 'https:' && url.hostname === 'www.linkedin.com' &&
		!url.port && !url.username && !url.password ? url : null;
}

function cookieValue(value, name) {
	if (typeof value !== 'string')
		return null;
	let normalized = value.trim();
	if (name === 'JSESSIONID' && normalized.startsWith('"') && normalized.endsWith('"'))
		normalized = normalized.slice(1, -1);
	return normalized && normalized.length <= MAX_COOKIE_VALUE && !/[;\r\n\0]/.test(normalized)
		? normalized : null;
}

function domainMatches(host, domain) {
	return host === domain || host.endsWith('.' + domain);
}

function pathMatches(requestPath, cookiePath) {
	return requestPath === cookiePath || requestPath.startsWith(cookiePath) &&
		(cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/');
}

function defaultPath(requestPath) {
	const finalSlash = requestPath.lastIndexOf('/');
	return finalSlash <= 0 ? '/' : requestPath.slice(0, finalSlash);
}

function seedDigest(liAt, jsessionId) {
	return crypto.createHash('sha256').update(liAt).update('\0').update(jsessionId).digest('hex');
}

function cookieKey(cookie) {
	return [cookie.domain, cookie.path, cookie.name].join('\0');
}

function parseSetCookie(header, responseUrl, now) {
	if (typeof header !== 'string' || header.length > 16384 || /[\r\n\0]/.test(header))
		return { invalid: true, authCookie: false };
	const parts = header.split(';');
	const pair = parts.shift() || '';
	const separator = pair.indexOf('=');
	if (separator < 1)
		return { invalid: true, authCookie: false };
	const name = pair.slice(0, separator).trim();
	const authCookie = name === 'li_at' || name === 'JSESSIONID';
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name))
		return { invalid: true, authCookie };
	const value = cookieValue(pair.slice(separator + 1), name);
	if (value === null && pair.slice(separator + 1).trim() !== '')
		return { invalid: true, authCookie };

	const attributes = {};
	let secure = false;
	for (const rawAttribute of parts) {
		const attributeSeparator = rawAttribute.indexOf('=');
		const attributeName = (attributeSeparator === -1 ? rawAttribute :
			rawAttribute.slice(0, attributeSeparator)).trim().toLowerCase();
		if (attributeName === 'secure') {
			secure = true;
			continue;
		}
		if (!['domain', 'path', 'max-age', 'expires'].includes(attributeName))
			continue;
		if (attributeSeparator === -1 || own(attributes, attributeName))
			return { invalid: true, authCookie };
		attributes[attributeName] = rawAttribute.slice(attributeSeparator + 1).trim();
	}

	const responseHost = responseUrl.hostname.toLowerCase();
	let domain = responseHost;
	let hostOnly = true;
	if (attributes.domain) {
		domain = attributes.domain.toLowerCase().replace(/^\./, '');
		if (!linkedinHosts.has(domain) || !domainMatches(responseHost, domain))
			return { ignored: true };
		hostOnly = false;
	}
	const cookiePath = attributes.path && attributes.path.startsWith('/')
		? attributes.path : defaultPath(responseUrl.pathname);
	if (cookiePath.length > 1024)
		return { invalid: true, authCookie };

	let expiresAt = null;
	if (attributes['max-age']) {
		if (!/^-?\d+$/.test(attributes['max-age']))
			return { invalid: true, authCookie };
		const seconds = Number(attributes['max-age']);
		expiresAt = seconds <= 0 ? now : Math.min(now + seconds * 1000, Number.MAX_SAFE_INTEGER);
	} else if (attributes.expires) {
		expiresAt = Date.parse(attributes.expires);
		if (!Number.isFinite(expiresAt))
			return { invalid: true, authCookie };
	}

	return {
		cookie: {
			name,
			value: value || '',
			domain,
			hostOnly,
			path: cookiePath,
			secure,
			expiresAt,
			deleted: !value || expiresAt !== null && expiresAt <= now
		}
	};
}

class SessionJar {
	constructor(options) {
		options = options || {};
		this.now = options.now || Date.now;
		this.stateFile = options.stateFile === false ? null :
			path.resolve(options.stateFile || '.sessions/linkedin.json');
		this.cookies = new Map();
		this.creationOrder = 0;
		this.seedDigest = options.liAt && options.jsessionId
			? seedDigest(options.liAt, options.jsessionId) : null;
		const state = this.loadState();
		if (state && state.valid && state.seedDigest === this.seedDigest)
			return;
		if (state && state.invalidated && state.seedDigest === this.seedDigest)
			throw this.sessionError('The saved LinkedIn session was invalidated; provision a new cookie pair.');
		this.cookies.clear();
		this.seed(options.liAt, options.jsessionId);
		this.persist(false);
	}

	seed(liAt, jsessionId) {
		const safeLiAt = cookieValue(liAt, 'li_at');
		const safeSession = cookieValue(jsessionId, 'JSESSIONID');
		if (!safeLiAt || !safeSession)
			throw this.sessionError('Both LINKEDIN_LI_AT and LINKEDIN_JSESSIONID are required.');
		this.cookies.clear();
		this.addCookie({ name: 'li_at', value: safeLiAt });
		this.addCookie({ name: 'JSESSIONID', value: safeSession });
	}

	addCookie(cookie) {
		const stored = {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain || 'linkedin.com',
			hostOnly: cookie.hostOnly === true,
			path: cookie.path || '/',
			secure: cookie.secure !== false,
			expiresAt: Number.isFinite(cookie.expiresAt) ? cookie.expiresAt : null,
			creationOrder: Number.isSafeInteger(cookie.creationOrder)
				? cookie.creationOrder : this.creationOrder++
		};
		this.creationOrder = Math.max(this.creationOrder, stored.creationOrder + 1);
		this.cookies.set(cookieKey(stored), stored);
	}

	headersFor(value) {
		const url = trustedUrl(value);
		if (!url)
			throw this.sessionError('Refusing to send LinkedIn cookies to an untrusted URL.');
		const now = this.now();
		this.removeExpired(now);
		const applicable = Array.from(this.cookies.values()).filter(cookie =>
			(cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain)) &&
			pathMatches(url.pathname, cookie.path) && (!cookie.secure || url.protocol === 'https:'))
			.sort((left, right) => right.path.length - left.path.length ||
				left.creationOrder - right.creationOrder);
		const liAt = applicable.find(cookie => cookie.name === 'li_at');
		const jsessionId = applicable.find(cookie => cookie.name === 'JSESSIONID');
		if (!liAt || !jsessionId)
			throw this.sessionError('The LinkedIn session is unavailable.');
		return {
			Cookie: applicable.map(cookie => cookie.name === 'JSESSIONID'
				? 'JSESSIONID="' + cookie.value + '"' : cookie.name + '=' + cookie.value).join('; '),
			'csrf-token': jsessionId.value
		};
	}

	absorbResponse(value, response) {
		const url = trustedUrl(value);
		if (!url)
			throw this.sessionError('Refusing cookies from an untrusted URL.');
		let rawHeaders = [];
		if (response && response.headers && typeof response.headers.getSetCookie === 'function')
			rawHeaders = response.headers.getSetCookie();
		else if (response && response.headers && typeof response.headers.raw === 'function')
			rawHeaders = response.headers.raw()['set-cookie'] || [];
		if (rawHeaders.length > 64)
			return this.invalidate('LinkedIn returned too many cookie updates.');
		const now = this.now();
		let updated = false;
		for (const header of rawHeaders) {
			const parsed = parseSetCookie(header, url, now);
			if (parsed.ignored)
				continue;
			if (parsed.invalid) {
				if (parsed.authCookie)
					return this.invalidate('LinkedIn returned an invalid authentication cookie.');
				continue;
			}
			if (parsed.cookie.name === 'li_at' || parsed.cookie.name === 'JSESSIONID') {
				for (const entry of this.cookies) {
					if (entry[1].name === parsed.cookie.name) {
						this.cookies.delete(entry[0]);
						updated = true;
					}
				}
			}
			const key = cookieKey(parsed.cookie);
			if (parsed.cookie.deleted) {
				updated = this.cookies.delete(key) || updated;
				continue;
			}
			if (!this.cookies.has(key) && this.cookies.size >= MAX_COOKIES)
				return this.invalidate('The LinkedIn cookie jar reached its safe capacity.');
			const previous = this.cookies.get(key);
			this.addCookie(Object.assign({}, parsed.cookie, {
				creationOrder: previous ? previous.creationOrder : undefined
			}));
			const cookieChanged = !previous || previous.value !== parsed.cookie.value ||
				previous.expiresAt !== parsed.cookie.expiresAt || previous.secure !== parsed.cookie.secure;
			updated = updated || cookieChanged;
		}
		if (updated)
			this.persist(false);
		try {
			this.headersFor(url);
		} catch (error) {
			return this.invalidate('LinkedIn cleared the active session.');
		}
		return { updated, invalidated: false };
	}

	removeExpired(now) {
		let updated = false;
		for (const entry of this.cookies) {
			if (entry[1].expiresAt !== null && entry[1].expiresAt <= now) {
				this.cookies.delete(entry[0]);
				updated = true;
			}
		}
		if (updated)
			this.persist(false);
	}

	invalidate(message) {
		this.cookies.clear();
		this.persist(true);
		throw this.sessionError(message);
	}

	loadState() {
		if (!this.stateFile || !fs.existsSync(this.stateFile))
			return null;
		try {
			const stat = fs.statSync(this.stateFile);
			if (stat.size > 262144)
				return null;
			const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
			if (!state || state.version !== STATE_VERSION)
				return null;
			if (state.invalidated)
				return { invalidated: true, seedDigest: state.seedDigest || null };
			if (!Array.isArray(state.cookies) || state.cookies.length > MAX_COOKIES)
				return null;
			for (const cookie of state.cookies) {
				if (!cookie || !cookieValue(cookie.value, cookie.name) ||
					!linkedinHosts.has(cookie.domain) || !cookie.path || !cookie.path.startsWith('/'))
					return null;
				this.addCookie(cookie);
			}
			this.headersFor('https://www.linkedin.com/');
			return { valid: true, seedDigest: state.seedDigest || null };
		} catch (error) {
			this.cookies.clear();
			return null;
		}
	}

	persist(invalidated) {
		if (!this.stateFile)
			return;
		fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
		const state = invalidated ? {
			version: STATE_VERSION,
			invalidated: true,
			seedDigest: this.seedDigest
		} : {
			version: STATE_VERSION,
			invalidated: false,
			seedDigest: this.seedDigest,
			cookies: Array.from(this.cookies.values())
		};
		fs.writeFileSync(this.stateFile, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
	}

	sessionError(message) {
		const error = new Error(message);
		error.code = 'LINKEDIN_SESSION_UNAVAILABLE';
		return error;
	}
}

module.exports = SessionJar;
