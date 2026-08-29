const { ApiError } = require('./VoyagerError');

const PROFILE_ENDPOINT = 'https://www.linkedin.com/voyager/api/identity/dash/profiles';
const PROFILE_DECORATION = 'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const MAX_COOKIE_HEADER_BYTES = 32768;
const MAX_COOKIE_COUNT = 64;

function parseCookieHeader(value) {
	const cookies = new Map();
	if (value === undefined || value === null || value === '')
		return cookies;
	if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_COOKIE_HEADER_BYTES ||
		/[\r\n\0]/.test(value))
		throw new Error('LINKEDIN_COOKIE_HEADER is invalid.');
	const entries = value.split(';');
	if (entries.length > MAX_COOKIE_COUNT)
		throw new Error('LINKEDIN_COOKIE_HEADER contains too many cookies.');
	for (const entry of entries) {
		const separator = entry.indexOf('=');
		if (separator < 1)
			throw new Error('LINKEDIN_COOKIE_HEADER is invalid.');
		const name = entry.slice(0, separator).trim();
		const cookieValue = entry.slice(separator + 1).trim();
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name) ||
			cookieValue.length > 4096 || /[\r\n\0;]/.test(cookieValue))
			throw new Error('LINKEDIN_COOKIE_HEADER is invalid.');
		cookies.set(name, cookieValue);
	}
	return cookies;
}

function mergeCookieHeaders(sessionHeader, browserCookies) {
	const merged = new Map(browserCookies);
	for (const [name, value] of parseCookieHeader(sessionHeader))
		merged.set(name, value);
	return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

function userAgent(value) {
	if (value === undefined || value === null || value === '')
		return DEFAULT_USER_AGENT;
	if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value))
		throw new Error('LINKEDIN_USER_AGENT is invalid.');
	return value;
}

function retryAfterSeconds(value) {
	if (typeof value !== 'string' || value.length > 128)
		return DEFAULT_COOLDOWN_SECONDS;
	if (/^\d+$/.test(value.trim())) {
		const seconds = Number(value.trim());
		return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_COOLDOWN_SECONDS;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? Math.max(1, Math.ceil((timestamp - Date.now()) / 1000))
		: DEFAULT_COOLDOWN_SECONDS;
}

function isJsonResponse(response) {
	const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	return mediaType === 'application/json' ||
		mediaType === 'application/vnd.linkedin.normalized+json+2.1';
}

async function boundedJson(response) {
	if (!response.body)
		throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done)
				break;
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES)
				throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
			chunks.push(chunk.value);
		}
		const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
		return JSON.parse(body);
	} catch (error) {
		if (error instanceof ApiError)
			throw error;
		throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
	} finally {
		reader.releaseLock();
	}
}

class VoyagerHttpClient {
	constructor(options) {
		if (!options || !options.jar)
			throw new Error('A LinkedIn session jar is required.');
		this.jar = options.jar;
		this.fetch = options.fetch || globalThis.fetch;
		if (typeof this.fetch !== 'function')
			throw new Error('A fetch implementation is required.');
		this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.browserCookies = parseCookieHeader(options.cookieHeader);
		this.userAgent = userAgent(options.userAgent);
		this.inFlight = false;
		this.cooldownUntil = 0;
	}

	async readProfile(publicIdentifier) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(publicIdentifier))
			throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
		if (this.inFlight)
			throw new ApiError('SERVICE_BUSY');
		const cooldown = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
		if (cooldown > 0)
			throw new ApiError('LINKEDIN_THROTTLED', { retryAfterSeconds: cooldown });

		this.inFlight = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		if (typeof timer.unref === 'function')
			timer.unref();
		try {
			const url = new URL(PROFILE_ENDPOINT);
			url.searchParams.set('q', 'memberIdentity');
			url.searchParams.set('memberIdentity', publicIdentifier);
			url.searchParams.set('decorationId', PROFILE_DECORATION);
			const sessionHeaders = this.jar.headersFor(url);
			const response = await this.fetch(url.href, {
				method: 'GET',
				redirect: 'manual',
				signal: controller.signal,
				headers: Object.assign({
					accept: 'application/vnd.linkedin.normalized+json+2.1',
					'accept-language': 'en-US,en;q=0.9',
					'cache-control': 'no-cache',
					'user-agent': this.userAgent,
					'x-li-lang': 'en_US',
					'x-restli-protocol-version': '2.0.0'
				}, sessionHeaders, {
					Cookie: mergeCookieHeaders(sessionHeaders.Cookie, this.browserCookies),
					referer: `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier)}/`
				})
			});

			this.jar.absorbResponse(url, response);
			if (response.redirected || response.status >= 300 && response.status < 400 ||
				[401, 403, 999].includes(response.status))
				this.jar.invalidate('LinkedIn redirected or rejected the authenticated session.');
			if (response.status === 429) {
				const seconds = retryAfterSeconds(response.headers.get('retry-after'));
				this.cooldownUntil = Date.now() + seconds * 1000;
				throw new ApiError('LINKEDIN_THROTTLED', { retryAfterSeconds: seconds });
			}
			if (response.status === 404)
				throw new ApiError('PROFILE_NOT_FOUND');
			if (response.status >= 500)
				throw new ApiError('UPSTREAM_UNAVAILABLE');
			if (!response.ok)
				throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
			if (!isJsonResponse(response)) {
				const mediaType = response.headers.get('content-type') || '';
				if (/text\/html|application\/xhtml\+xml/i.test(mediaType))
					this.jar.invalidate('LinkedIn returned a login or checkpoint page.');
				throw new ApiError('UPSTREAM_SCHEMA_CHANGED');
			}
			return { payload: await boundedJson(response), fetchedAt: new Date() };
		} catch (error) {
			if (controller.signal.aborted)
				throw new ApiError('UPSTREAM_TIMEOUT');
			if (error && typeof error.code === 'string')
				throw error;
			throw new ApiError('UPSTREAM_UNAVAILABLE');
		} finally {
			clearTimeout(timer);
			this.inFlight = false;
		}
	}
}

module.exports = VoyagerHttpClient;
