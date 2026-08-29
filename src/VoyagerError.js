const messages = {
	PROFILE_NOT_FOUND: 'The LinkedIn profile could not be accessed.',
	UPSTREAM_SCHEMA_CHANGED: 'LinkedIn returned an unsupported response format.',
	UPSTREAM_UNAVAILABLE: 'LinkedIn is temporarily unavailable.',
	LINKEDIN_THROTTLED: 'LinkedIn has temporarily limited requests. Try again later.',
	LINKEDIN_SESSION_UNAVAILABLE: 'The LinkedIn session is temporarily unavailable.',
	SERVICE_BUSY: 'The service is currently at capacity.',
	UPSTREAM_TIMEOUT: 'LinkedIn did not respond in time.'
};

class ApiError extends Error {
	constructor(code, options = {}) {
		super(messages[code] || messages.UPSTREAM_UNAVAILABLE);
		this.name = 'ApiError';
		this.code = code;
		this.retryAfterSeconds = Number.isSafeInteger(options.retryAfterSeconds) &&
			options.retryAfterSeconds > 0 ? options.retryAfterSeconds : null;
	}
}

module.exports = { ApiError };
